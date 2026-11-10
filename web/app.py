# /// script
# requires-python = ">=3.10"
# dependencies = ["fastapi", "uvicorn"]
# ///
"""ASR eval results viewer. Run: uv run web/app.py [--port 8000]"""
import json
import sys
import threading
import webbrowser
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


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")

if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8000
    threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port)
