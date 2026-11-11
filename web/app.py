# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["fastapi", "uvicorn", "python-multipart", "faster-whisper", "av<14", "numpy", "whisper-normalizer"]
# ///
# python-multipart: lets FastAPI read file uploads (form-data). av<14: faster-whisper's audio
# loader breaks on PyAV 14+. faster-whisper is only imported when /api/transcribe is first used.
# whisper-normalizer: the same text normaliser scripts/run_eval.py scores with, so demo WER = eval WER.
"""ASR eval results viewer + clip labelling page + live demo.
Run: uv run web/app.py [--port 8000] [--label | --demo]"""
import base64
import csv
import io
import json
import os
import sys
import threading
import time
import wave
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
DEMO_LOOKUP_TIMEOUT = 15  # seconds: a person is waiting, so give up on the live lookup quickly
import route_hint  # noqa: E402  (lookup_route, build_hint: journey -> "Calling at A, B and C.")
RESULTS = ROOT / "results"
DATA = (ROOT / "data").resolve()
STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="ASR eval viewer")

# --- labelling -------------------------------------------------------------
RAW = DATA / "raw"
LABELS = RAW / "labels.csv"
AUDIO_EXT = {".mp3", ".wav", ".flac", ".ogg"}
SUGGESTED = ["fs267700", "fs96502", "fs65806", "fs83789"]  # listen-first picks
LABEL_FIELDS = ["clip_id", "kind", "keep", "seg_start", "seg_end", "transcript",
                "station", "platform", "time", "delay_min", "status",
                "accent", "gender", "noise_level", "notes", "draft_used", "labelled_at"]


def run_dir(run_id: str) -> Path:
    d = (RESULTS / run_id).resolve()
    if d.parent != RESULTS.resolve() or not (d / "run.json").is_file():
        raise HTTPException(404, "run not found")
    return d


def load(p: Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


@app.get("/api/runs")
def list_runs():
    if not RESULTS.is_dir():
        return []
    return sorted(p.name for p in RESULTS.iterdir() if (p / "run.json").is_file())


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    d = run_dir(run_id)
    return {"run": load(d / "run.json"), "summary": load(d / "summary.json")}


@app.get("/api/runs/{run_id}/predictions")
def get_predictions(run_id: str):
    p = run_dir(run_id) / "predictions.jsonl"
    if not p.is_file():
        return []
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


@app.get("/audio/{path:path}")
def audio(path: str):
    # audio_path in predictions is repo-relative ("data/v0/a.wav"); accept with or without "data/" prefix.
    rel = path[5:] if path.startswith("data/") else path
    f = (DATA / rel).resolve()
    if not f.is_relative_to(DATA) or not f.is_file():
        raise HTTPException(404, "audio not found")
    return FileResponse(f)


# --- live demo: transcription -----------------------------------------------
SAMPLE_RATE = 16000              # Whisper expects 16 kHz mono
MODEL_NAME = "whisper-small-int8"
NOISE_CLIP = RAW / "freesound_noise" / "fs343146.mp3"  # London Overground carriage ambience
NOISE_OFFSET_S = 10              # skip the first seconds of the noise recording
PA_BAND_HZ = (300, 3400)         # "PA speaker / phone line" band: cut lows (rumble) and highs

_model = None                    # loaded on first request, then reused (loading takes seconds)
_model_lock = threading.Lock()   # one transcription at a time: keeps memory use predictable
_noise = None                    # train noise, decoded once


def get_model():
    """Load Whisper Small int8 once. Prefer the copy already in the Hugging Face cache
    (local_files_only=True = never touch the network); download only if it isn't cached."""
    global _model
    if _model is None:
        from faster_whisper import WhisperModel  # heavy import: only when the demo is used
        try:
            _model = WhisperModel("small", device="cpu", compute_type="int8", local_files_only=True)
        except Exception:
            _model = WhisperModel("small", device="cpu", compute_type="int8")
    return _model


_normaliser = None


def normalise(text: str | None) -> str | None:
    """Whisper's English normaliser, exactly as scripts/run_eval.py uses it: lowercase, drop punctuation
    and [bracketed] text like [inaudible], "five" -> "5", British -> American spelling."""
    global _normaliser
    if text is None:
        return None
    if _normaliser is None:
        from whisper_normalizer.english import EnglishTextNormalizer
        _normaliser = EnglishTextNormalizer()
    return _normaliser(text)


def decode(source) -> np.ndarray:
    """Any audio PyAV can read (mp3, wav, flac, webm/opus from the browser...) -> 16 kHz mono float32."""
    from faster_whisper import decode_audio
    return decode_audio(source, sampling_rate=SAMPLE_RATE)


def rms(x: np.ndarray) -> float:
    """Root mean square = average loudness of a signal."""
    return float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0


def simulate_train(speech: np.ndarray, snr_db: float, pa_filter: bool) -> np.ndarray:
    """Make a clean recording sound like it was heard on a train:
    1. (optional) band-pass it like a cheap PA speaker,
    2. add real carriage noise so that speech is `snr_db` dB louder than the noise.
    SNR (signal-to-noise ratio): 10 dB = speech clearly louder, 0 dB = equally loud."""
    global _noise
    if _noise is None:
        if not NOISE_CLIP.is_file():
            raise HTTPException(400, f"noise clip missing: {NOISE_CLIP.name} (run scripts/download_data.py)")
        _noise = decode(str(NOISE_CLIP))
    x = speech.astype(np.float32)
    if pa_filter:  # zero every frequency outside the band (simple FFT filter, no scipy needed)
        spectrum = np.fft.rfft(x)
        freqs = np.fft.rfftfreq(len(x), 1 / SAMPLE_RATE)
        spectrum[(freqs < PA_BAND_HZ[0]) | (freqs > PA_BAND_HZ[1])] = 0
        x = np.fft.irfft(spectrum, n=len(x)).astype(np.float32)
    noise = _noise[NOISE_OFFSET_S * SAMPLE_RATE:]
    noise = np.tile(noise, int(np.ceil(len(x) / len(noise))))[:len(x)]  # loop if speech is longer
    # Scale the noise so that rms(speech) / rms(noise) = 10^(snr_db / 20)
    noise = noise * (rms(x) / (rms(noise) * 10 ** (snr_db / 20) + 1e-9))
    mixed = x + noise
    peak = float(np.max(np.abs(mixed))) if len(mixed) else 0.0
    return mixed / peak * 0.95 if peak > 1 else mixed  # avoid clipping


def wav_bytes(x: np.ndarray) -> bytes:
    """16 kHz float audio -> the bytes of a WAV file (16-bit mono)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit samples
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def wav_base64(x: np.ndarray) -> str:
    """WAV bytes as base64 text, so a JSON response can carry the audio the model heard."""
    return base64.b64encode(wav_bytes(x)).decode("ascii")


def decode_upload(audio: UploadFile) -> tuple[np.ndarray, bytes]:
    data = audio.file.read()
    if not data:
        raise HTTPException(400, "empty audio upload")
    try:
        return decode(io.BytesIO(data)), data
    except Exception as e:
        raise HTTPException(400, f"could not decode audio: {e}")


@app.post("/api/simulate")
def simulate_pa(audio: UploadFile = File(...), snr_db: float = Form(5.0), pa_filter: bool = Form(True)):
    """Return the upload as it would sound through a train PA (WAV), without transcribing.
    The demo plays this right after the original, then sends it to /api/transcribe."""
    samples, _ = decode_upload(audio)
    return Response(wav_bytes(simulate_train(samples, snr_db, pa_filter)), media_type="audio/wav")


EXCLUDED_KINDS = ("noise_only", "unusable")  # same clips scripts/run_eval.py skips (keep the two in sync)


def announcement_clips() -> dict:
    """Announcement clips the demo offers: the same set the eval scores."""
    labels = read_labels()
    return {k: v for k, v in raw_clips().items() if v["folder"] == "freesound_announcements"
            and labels.get(k, {}).get("kind") not in EXCLUDED_KINDS}


LOOKUP_DOWN = "live route lookup unavailable; preset journeys still work"


@app.get("/api/routes")
def list_routes():
    """The cached journeys (work offline), as quick picks for the demo."""
    return [{"origin": v["origin"], "destination": v["destination"], "stations": v["stations"]}
            for v in route_hint._load_cache().values()]


@app.get("/api/route")
def get_route(origin: str, destination: str):
    key = route_hint._key(origin, destination)
    cached = key in route_hint._load_cache()
    try:
        stations = route_hint.lookup_route(origin, destination, timeout=DEMO_LOOKUP_TIMEOUT)
    except Exception:
        raise HTTPException(503, LOOKUP_DOWN)
    if not stations:
        raise HTTPException(503, LOOKUP_DOWN)
    return {"origin": origin, "destination": destination, "stations": stations,
            "hint": route_hint.build_hint(stations), "cached": cached}


def clip_journeys() -> dict:
    f = RAW / "journeys.csv"
    if not f.is_file():
        return {}
    with f.open(encoding="utf-8", newline="") as fh:
        return {r["clip_id"]: {"origin": r["origin"], "destination": r["destination"]} for r in csv.DictReader(fh)}


@app.get("/api/demo/clips")
def demo_clips():
    """Announcement clips present on disk, with title and (if labelled) the human reference."""
    meta = {m["id"]: m for m in load(RAW / "_fs_ann_meta.json") or []}
    labels = read_labels()
    out = []
    journeys = clip_journeys()
    for cid, c in announcement_clips().items():
        m, lab = meta.get(cid, {}), labels.get(cid, {})
        out.append({"clip_id": cid, "audio_path": c["audio_path"], "title": m.get("title"),
                    "duration": m.get("dur"), "kind": lab.get("kind") or None,
                    "reference": lab.get("transcript") or None,
                    "seg_start": lab.get("seg_start") or None, "seg_end": lab.get("seg_end") or None, "journey": journeys.get(cid)})
    return out


@app.post("/api/transcribe")
def transcribe(
    audio: UploadFile | None = File(None),   # a recording from the browser (webm/opus, wav, mp3...)
    clip_id: str = Form(""),                 # ...or the id of a dataset clip already on disk
    journey: str = Form("{}"),               # JSON {"from","to","operator"}: future context hint
    denoise: bool = Form(False),             # accepted now, applied once exp/denoise merges
    context: bool = Form(False),             # accepted now, applied once exp/context merges
    simulate: bool = Form(False),            # mix in train noise before transcribing
    snr_db: float = Form(5.0),
    pa_filter: bool = Form(True),
):
    t_request = time.time()
    try:
        journey_obj = json.loads(journey or "{}")
    except json.JSONDecodeError:
        raise HTTPException(400, "journey must be JSON")

    # 1. Get the audio as a 16 kHz numpy array
    if audio is not None and audio.filename:
        samples, data = decode_upload(audio)
        source = {"type": "upload", "filename": audio.filename, "bytes": len(data)}
    elif clip_id:
        clips = announcement_clips()
        if clip_id not in clips:
            raise HTTPException(404, "unknown clip")
        samples = decode(str(ROOT / clips[clip_id]["audio_path"]))
        # Same trim as the eval: if the clip is labelled with an announcement segment, use it,
        # so the transcript can be compared with the human reference for that segment.
        lab = read_labels().get(clip_id, {})
        segment = None
        if lab.get("seg_start") or lab.get("seg_end"):
            s0 = float(lab.get("seg_start") or 0)
            s1 = float(lab["seg_end"]) if lab.get("seg_end") else None
            samples = samples[int(s0 * SAMPLE_RATE):int(s1 * SAMPLE_RATE) if s1 else None]
            segment = [s0, s1]
        source = {"type": "clip", "clip_id": clip_id, "segment": segment,
                  "reference": lab.get("transcript") or None}
    else:
        raise HTTPException(400, "send an 'audio' file or a 'clip_id'")
    if len(samples) < SAMPLE_RATE * 0.3:
        raise HTTPException(400, "audio too short (under 0.3 s)")

    # 2. Optional: make it sound like a train
    heard_wav = None
    if simulate:
        samples = simulate_train(samples, snr_db, pa_filter)
        heard_wav = wav_base64(samples)

    # 2b. Optional: route hint (Whisper's initial_prompt) from the journey
    hint, hint_error = None, None
    origin = (journey_obj.get("origin") or journey_obj.get("from") or "").strip()
    destination = (journey_obj.get("destination") or journey_obj.get("to") or "").strip()
    if context and origin and destination:
        try:
            hint = route_hint.build_hint(route_hint.lookup_route(origin, destination, timeout=DEMO_LOOKUP_TIMEOUT))
        except Exception:
            hint = None
        if hint is None:
            # Fallback: no route found, but the passenger typed origin + destination (correct spelling,
            # and the destination is often the key name), so use those as a minimal hint.
            hint = route_hint.build_hint([origin, destination])
            hint_error = LOOKUP_DOWN.rstrip(".") + ". Using just your origin and destination as the hint."

    # 3. Transcribe (same settings as scripts/run_eval.py, so the demo matches the eval)
    with _model_lock:
        t_load = time.time()
        model = get_model()
        load_s = time.time() - t_load
        t0 = time.time()
        segments, _info = model.transcribe(samples, language="en", beam_size=5, initial_prompt=hint)
        segments = list(segments)  # the real work happens here: segments is a lazy generator
        latency_s = time.time() - t0

    text = " ".join(seg.text.strip() for seg in segments).strip()
    return {
        "text": text,
        # Both sides normalised exactly like the eval, so the page's diff and WER match run_eval.py.
        "text_norm": normalise(text),
        "reference_norm": normalise(source.get("reference")),
        "latency_s": round(latency_s, 2),               # model time only, like inference_s in the eval
        "total_s": round(time.time() - t_request, 2),   # whole request: decode + mix + model (+ load)
        "model_load_s": round(load_s, 2),               # > 0 only on the first request
        "audio_s": round(len(samples) / SAMPLE_RATE, 2),
        "model": MODEL_NAME,
        "segments": [{"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip(),
                      "no_speech_prob": round(seg.no_speech_prob, 2)} for seg in segments],
        "source": source,
        "journey": journey_obj,
        "simulate": {"snr_db": snr_db, "pa_filter": pa_filter,
                     "noise_clip": NOISE_CLIP.stem} if simulate else None,
        "heard_wav_b64": heard_wav,                      # what the model heard (only when simulated)
        "denoise": {"requested": denoise, "applied": False},  # TODO: exp/denoise
        "context": {"requested": context, "applied": hint is not None},
        "hint": hint,
        "hint_error": hint_error,
    }


def read_labels() -> dict:
    if not LABELS.is_file():
        return {}
    with LABELS.open(encoding="utf-8", newline="") as f:
        return {r["clip_id"]: r for r in csv.DictReader(f)}


def raw_clips() -> dict:
    """All audio files under data/raw/<source>/, keyed by file stem."""
    clips = {}
    if RAW.is_dir():
        for f in sorted(RAW.glob("*/*")):
            if f.suffix.lower() in AUDIO_EXT:
                clips.setdefault(f.stem, {"clip_id": f.stem, "folder": f.parent.name,
                                          "audio_path": f.relative_to(ROOT).as_posix()})
    return clips


def latest_drafts() -> dict:
    """{clip_id: {model: hypothesis}} from real eval runs (not mock), newest run wins.
    Shown on the label page as drafts to correct - never saved as a reference automatically."""
    runs = []
    for d in (RESULTS.iterdir() if RESULTS.is_dir() else []):
        info = load(d / "run.json")
        if info and d.name != "mock" and (d / "predictions.jsonl").is_file():
            runs.append((info.get("created_at", ""), d))
    drafts = {}
    for _, d in sorted(runs):  # oldest first, so newer runs overwrite
        for line in (d / "predictions.jsonl").read_text(encoding="utf-8").splitlines():
            if line.strip():
                p = json.loads(line)
                drafts.setdefault(p["clip_id"], {})[p["model"]] = p["hypothesis"]
    return drafts


@app.get("/api/clips")
def list_clips():
    clips = raw_clips()
    drafts = latest_drafts()
    for name in ("_fs_ann_meta.json", "_fs_noise_meta.json"):
        for m in load(RAW / name) or []:
            if m["id"] in clips:
                clips[m["id"]].update(title=m.get("title"), url=m.get("url"),
                                      licence=m.get("lic"), description=m.get("desc"))
    cand = RAW / "candidates.csv"
    if cand.is_file():
        with cand.open(encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r["id"] in clips:
                    clips[r["id"]]["guess"] = {k: r.get(k) for k in
                                               ("human_or_automated", "accent_region", "noise_level", "duration")}
    labels = read_labels()
    for c in clips.values():
        c["suggested"] = c["clip_id"] in SUGGESTED
        c["drafts"] = drafts.get(c["clip_id"], {})
        c["label"] = labels.get(c["clip_id"])
    order = lambda c: (not c["suggested"], SUGGESTED.index(c["clip_id"]) if c["suggested"] else 0,
                       c["folder"] != "freesound_announcements", c["clip_id"])
    return sorted(clips.values(), key=order)


@app.post("/api/labels/{clip_id}")
def save_label(clip_id: str, body: dict):
    if clip_id not in raw_clips():
        raise HTTPException(404, "unknown clip")
    labels = read_labels()
    row = {k: str(body.get(k) or "").strip() for k in LABEL_FIELDS}
    row["clip_id"] = clip_id
    row["labelled_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    labels[clip_id] = row
    tmp = LABELS.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=LABEL_FIELDS)
        w.writeheader()
        w.writerows(labels[k] for k in sorted(labels))
    os.replace(tmp, LABELS)
    return row


@app.get("/label")
def label_page():
    return FileResponse(STATIC / "label.html")


@app.get("/context")
def context_page():
    return FileResponse(STATIC / "context.html")


@app.get("/regressions")
def regressions_page():
    return FileResponse(STATIC / "regressions.html")


@app.get("/demo")
def demo_page():
    return FileResponse(STATIC / "demo.html")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")

if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8000
    page = "/label" if "--label" in sys.argv else "/demo" if "--demo" in sys.argv else ""
    threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}{page}")).start()
    if "--demo" in sys.argv:
        # Load the model now, in the background, so the first demo transcription isn't slowed by it.
        # Holding the lock means a request that arrives mid-load waits instead of loading a second copy.
        def preload():
            with _model_lock:
                get_model()
        threading.Thread(target=preload, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port)
