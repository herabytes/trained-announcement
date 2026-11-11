"""Route lookup on Modal: origin + destination -> the stations a train calls at (Gemini + Google Search).

Why it lives on Modal: the Gemini key stays in a Modal secret, so a reviewer running the demo
locally never needs a key. Results are cached (in a modal.Dict) and capped per day, so the same
route is only looked up once and nobody can run up the bill.

    uvx modal run deploy/route_lookup.py::list_models     # check which Gemini models the key can use
    uvx modal deploy deploy/route_lookup.py               # deploy; prints the endpoint URL

Needs a Modal secret named "gemini" containing GEMINI_API_KEY.
"""
import datetime
import os

import modal

app = modal.App("trained-announcement-route-lookup")
image = modal.Image.debian_slim().uv_pip_install("fastapi[standard]", "google-genai")
cache = modal.Dict.from_name("trained-announcement-route-cache", create_if_missing=True)

MODEL = "gemini-3.8-flash"   # 2.5 models are closed to new users (404); newest flash available to the key
DAILY_CAP = 100              # max fresh lookups per day (cached routes don't count)
MAX_STATIONS = 30            # keeps the Whisper hint short


def ask_gemini(origin: str, destination: str) -> list[str]:
    """One grounded Gemini call: returns station names in calling order."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    prompt = (
        f"List the UK railway stations a typical train calls at travelling from {origin} to {destination}, "
        "in order, including both ends. Use the official National Rail station names. "
        "Reply with ONLY the station names separated by ' | ' and nothing else."
    )
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(tools=[types.Tool(google_search=types.GoogleSearch())]),
    )
    stations = [name.strip(" .\n*") for name in (response.text or "").split("|")]
    return [s for s in stations if s][:MAX_STATIONS]


@app.function(image=image, secrets=[modal.Secret.from_name("gemini")], timeout=90)
@modal.fastapi_endpoint(method="GET")
def route(origin: str, destination: str):
    from fastapi import HTTPException

    origin, destination = origin.strip(), destination.strip()
    if not (0 < len(origin) <= 60 and 0 < len(destination) <= 60):
        raise HTTPException(400, "origin and destination must be 1-60 characters")

    key = f"route:{origin.lower()} -> {destination.lower()}"
    if key in cache:                                   # 1. already looked up: free and instant
        return {"origin": origin, "destination": destination, "stations": cache[key], "cached": True}

    day_key = f"count:{datetime.date.today().isoformat()}"
    if cache.get(day_key, 0) >= DAILY_CAP:             # 2. daily cap reached
        raise HTTPException(429, "daily lookup limit reached; try a cached journey")
    cache[day_key] = cache.get(day_key, 0) + 1

    try:                                               # 3. fresh lookup, then remember it
        stations = ask_gemini(origin, destination)
    except Exception as e:  # e.g. Gemini quota (429): say so instead of a bare 500
        raise HTTPException(502, f"route lookup failed: {type(e).__name__}: {str(e)[:200]}")
    if stations:
        cache[key] = stations
    return {"origin": origin, "destination": destination, "stations": stations, "cached": False}


@app.function(image=image, secrets=[modal.Secret.from_name("gemini")])
def list_models():
    """Print the Gemini 'flash' models this key can use (run before deploying)."""
    from google import genai

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    names = [m.name for m in client.models.list() if "flash" in m.name]
    print("\n".join(sorted(names)))


@app.function(image=image, secrets=[modal.Secret.from_name("gemini")])
def ping(use_search: bool = False):
    """Debug helper: one tiny Gemini request, with or without Google Search, to check the key's quota."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    tools = [types.Tool(google_search=types.GoogleSearch())] if use_search else None
    r = client.models.generate_content(model=MODEL, contents="Say OK.", config=types.GenerateContentConfig(tools=tools))
    print(f"use_search={use_search}: {r.text!r}")
