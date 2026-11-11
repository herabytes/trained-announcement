"""Journey -> station list -> Whisper hint.

The idea: when you board, the app knows your journey (e.g. Ladybank -> Edinburgh). It looks up the
stations on that route ONCE (while you still have signal) and uses them as Whisper's hint for every
announcement on the trip, so place names like "Kirkcaldy" are expected instead of misheard.

    lookup_route("Ladybank", "Edinburgh")  -> ["Ladybank", "Markinch", "Kirkcaldy", ...]
    build_hint(stations)                   -> "Calling at Ladybank, Markinch, Kirkcaldy, ... and Edinburgh Waverley."
    hint_for_clip("fs65806")               -> the hint for an eval clip, via data/raw/journeys.csv

Where station lists come from:
  1. data/route_cache.json  (committed: works offline and without any API key)
  2. otherwise the route-lookup endpoint on Modal (deploy/route_lookup.py); the answer is saved to the cache.

Why the hint looks like announcement text: Whisper's hint isn't an instruction, it's "text that came
just before", so it works best as short, exactly-spelled text in the style of what will be said.
"""
import csv
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_FILE = REPO_ROOT / "data" / "route_cache.json"
JOURNEYS_FILE = REPO_ROOT / "data" / "raw" / "journeys.csv"
LOOKUP_URL = os.environ.get(
    "ROUTE_LOOKUP_URL", "https://merchyaqua--trained-announcement-route-lookup-route.us-east.modal.run")


# Used when the journey isn't known (the eval's "context" condition; the demo's Compare for clips
# without station info).
# Contextual biasing: text Whisper "reads" before listening, so it expects these words/spellings.
# Chosen by a NEUTRAL rule - London terminals + largest city stations + operators (incl. pre-2020
# brands) + standard announcement phrases - NOT copied from any clip's transcript (that would leak
# the answer). Same hint for every clip. Whisper only uses ~220 tokens of prompt, so keep it short.
GENERIC_HINT = (
    "UK train announcement. Ladies and gentlemen, the next station is ... Calling at ... "
    "Change here for ... Please mind the gap. Oyster card, contactless, platform, coaches, first class, "
    "delayed, cancelled, signal failure. "
    "London Paddington, Euston, King's Cross, St Pancras, Liverpool Street, Victoria, Waterloo, "
    "London Bridge, Marylebone, Birmingham New Street, Manchester Piccadilly, Leeds, York, Newcastle, "
    "Glasgow Central, Glasgow Queen Street, Edinburgh Waverley, Liverpool Lime Street, "
    "Bristol Temple Meads, Cardiff Central, Reading, Clapham Junction. "
    "ScotRail, Avanti West Coast, Virgin Trains, Great Western Railway, First Great Western, LNER, "
    "Northern, TransPennine Express, CrossCountry, Southern, Southeastern, South Western Railway, "
    "Thameslink, Greater Anglia, London Overground, Elizabeth line, London Underground."
)


def _key(origin: str, destination: str) -> str:
    return f"{origin.strip().lower()} -> {destination.strip().lower()}"


def _load_cache() -> dict:
    return json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.is_file() else {}


def lookup_route(origin: str, destination: str) -> list[str]:
    """Stations on the route, in order. Cache first; otherwise ask the Modal endpoint (and cache it)."""
    cache = _load_cache()
    key = _key(origin, destination)
    if key in cache:
        return cache[key]["stations"]

    url = LOOKUP_URL + "?" + urllib.parse.urlencode({"origin": origin, "destination": destination})
    with urllib.request.urlopen(url, timeout=120) as response:   # raises if the lookup fails
        stations = json.loads(response.read())["stations"]
    if stations:
        cache[key] = {"origin": origin, "destination": destination, "stations": stations,
                      "source": "route-lookup endpoint (deploy/route_lookup.py)"}
        CACHE_FILE.write_text(json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8")
    return stations


def build_hint(stations: list[str]) -> str | None:
    """Short, exactly-spelled, announcement-style text: 'Calling at A, B and C.'"""
    if not stations:
        return None
    if len(stations) == 1:
        return f"Calling at {stations[0]}."
    return "Calling at " + ", ".join(stations[:-1]) + f" and {stations[-1]}."


def hint_for_clip(clip_id: str) -> str | None:
    """Eval helper: the hint for a clip's journey (from data/raw/journeys.csv), or None if it has none."""
    if not JOURNEYS_FILE.is_file():
        return None
    with JOURNEYS_FILE.open(encoding="utf-8", newline="") as f:
        journey = next((row for row in csv.DictReader(f) if row["clip_id"] == clip_id), None)
    return build_hint(lookup_route(journey["origin"], journey["destination"])) if journey else None
