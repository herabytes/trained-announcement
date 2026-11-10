# ASR eval results viewer

FastAPI backend + plain HTML/JS frontend (no build step).

## Run

    uv run web/app.py            # http://127.0.0.1:8000 (opens browser); --port N to change

uv installs fastapi/uvicorn automatically (inline script deps in `app.py`).

## What it reads
- `results/<run_id>/{run.json,predictions.jsonl,summary.json}` per `docs/results_schema.md`.
- Audio from `data/` only, at `/audio/<audio_path>` (`audio_path` like `data/v0/a0001.wav`). Missing audio shows a notice.
- API: `GET /api/runs`, `/api/runs/{id}`, `/api/runs/{id}/predictions`, `/audio/{path}`; `POST /api/transcribe` is a 501 stub (TODO: live transcription / Modal proxy).

## Add a real run
Drop a folder with the three files into `results/` and reload. `results/mock/` is fake sample data.
