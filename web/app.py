# /// script
# requires-python = ">=3.10"
# dependencies = ["fastapi", "uvicorn"]
# ///
"""ASR eval results viewer + clip labelling page. Run: uv run web/app.py [--port 8000]"""
import csv
import json
import os
import sys
import threading
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
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


@app.post("/api/transcribe")
def transcribe():
    # TODO: live transcription. Accept an audio upload, run a model locally or proxy to a
    # Modal GPU endpoint, return {"text": ...}. Not implemented yet.
    return JSONResponse({"detail": "not implemented"}, status_code=501)


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


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")

if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8000
    page = "/label" if "--label" in sys.argv else ""
    threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}{page}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port)
