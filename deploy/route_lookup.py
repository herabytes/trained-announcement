"""Route lookup on Modal: origin + destination -> the stations a train calls at (open LLM on a Modal GPU).

Why it lives on Modal: the model runs on Modal's GPUs (paid from Modal credits, no Gemini/OpenAI key),
so a reviewer running the demo locally needs nothing. Results are cached (in a modal.Dict) and capped
per day, so the same route is only looked up once and nobody can burn the credits.

NOTE: there is no web search here. The station list comes purely from the model's own knowledge,
so it can be incomplete or wrong for obscure routes; treat it as a hint, not ground truth.

    uvx modal deploy deploy/route_lookup.py               # deploy; prints the endpoint URL
"""
import datetime

import modal

app = modal.App("trained-announcement-route-lookup")
cache = modal.Dict.from_name("trained-announcement-route-cache", create_if_missing=True)

MODEL = "Qwen/Qwen3-8B"      # ungated (Apache-2.0), strong general knowledge; ~16 GB bf16 fits a 24 GB L4
GPU = "L4"
DAILY_CAP = 100              # max fresh lookups per day (cached routes don't count)
MAX_STATIONS = 30            # keeps the Whisper hint short

weights = modal.Volume.from_name("trained-announcement-hf-cache", create_if_missing=True)
WEIGHTS_DIR = "/hf-cache"

web_image = modal.Image.debian_slim().uv_pip_install("fastapi[standard]")
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("torch==2.6.0", "transformers==4.53.2", "accelerate==1.8.1", "huggingface_hub[hf_transfer]")
    .env({"HF_HOME": WEIGHTS_DIR, "HF_HUB_ENABLE_HF_TRANSFER": "1"})
)


@app.cls(image=gpu_image, gpu=GPU, volumes={WEIGHTS_DIR: weights}, scaledown_window=120, timeout=600)
class RouteModel:
    @modal.enter()
    def load(self):
        import torch
        from huggingface_hub import snapshot_download
        from transformers import AutoModelForCausalLM, AutoTokenizer

        path = snapshot_download(MODEL)     # no-op once the weights are on the Volume
        weights.commit()
        self.tok = AutoTokenizer.from_pretrained(path)
        self.model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=torch.bfloat16, device_map="cuda")
        self.model.eval()

    @modal.method()
    def stations(self, origin: str, destination: str) -> list[str]:
        import torch

        prompt = (
            f"List the UK railway stations a typical train calls at travelling from {origin} to {destination}, "
            "in order, including both ends. Use the official National Rail station names, and only include "
            "stations you are confident exist. Reply with ONLY the station names separated by ' | ' and nothing else."
        )
        text = self.tok.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False, add_generation_prompt=True, enable_thinking=False,   # Qwen3: no <think> block
        )
        inputs = self.tok(text, return_tensors="pt").to("cuda")
        with torch.no_grad():
            out = self.model.generate(**inputs, max_new_tokens=400, do_sample=False)  # greedy = deterministic
        reply = self.tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        return parse_stations(reply)


def parse_stations(reply: str) -> list[str]:
    seen, stations = set(), []
    for name in reply.replace("\n", "|").split("|"):
        name = name.strip(" .*-\t")
        if name and name.lower() not in seen:
            seen.add(name.lower())
            stations.append(name)
    return stations[:MAX_STATIONS]


@app.function(image=web_image, timeout=600)
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

    try:                                               # 3. fresh lookup on the GPU, then remember it
        stations = RouteModel().stations.remote(origin, destination)
    except Exception as e:  # say what failed instead of a bare 500
        raise HTTPException(502, f"route lookup failed: {type(e).__name__}: {str(e)[:200]}")
    if stations:
        cache[key] = stations
    return {"origin": origin, "destination": destination, "stations": stations, "cached": False}
