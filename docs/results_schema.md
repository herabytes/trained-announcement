# Results schema (draft v0 — contract between eval runner and web frontend)

Rough on purpose. Change it once real results show what matters; frontend + runner update together.

## Layout

```
results/<run_id>/
  run.json            # what was run
  predictions.jsonl   # one line per (clip, model)
  summary.json        # per-model aggregates
```

## run.json

```json
{
  "run_id": "2026-11-10_v0_baseline",
  "created_at": "2026-11-10T15:00:00Z",
  "dataset": "data/v0",
  "models": ["parakeet-tdt-0.6b-v3", "whisper-small"],
  "normalizer": "whisper_english",
  "fact_score_wrong_weight": 2,
  "notes": "first real run"
}
```

## predictions.jsonl (one JSON object per line)

```json
{
  "clip_id": "a0001",
  "audio_path": "data/v0/a0001.wav",
  "model": "parakeet-tdt-0.6b-v3",
  "reference": "The 14:32 to Leeds will now depart from platform 8.",
  "hypothesis": "the 1432 to leeds will now depart from platform 6",
  "reference_norm": "the 14 32 to leeds will now depart from platform 8",
  "hypothesis_norm": "the 1432 to leeds will now depart from platform 6",
  "wer": 0.2,
  "facts": [
    {"field": "station",  "ref": "Leeds", "hyp": "Leeds", "verdict": "correct"},
    {"field": "platform", "ref": "8",     "hyp": "6",     "verdict": "wrong"},
    {"field": "delay_min","ref": null,    "hyp": null,    "verdict": "not_applicable"}
  ],
  "fact_score": -1,
  "meta": {"source": "online", "channel": "real_phone", "noise_level": "high", "snr_db": null, "accent": "yorkshire", "gender": "m", "type": "platform_change", "duration_s": 9.8}
}
```

- `verdict`: `correct` | `wrong` | `missing` (ref has it, hyp doesn't) | `not_applicable` (neither has it). Hyp states a fact the ref doesn't have → `wrong` (hallucination).
- `fact_score` = correct − `fact_score_wrong_weight` × wrong (missing = 0).
- `meta` is copied from the dataset's `metadata.csv` row; any column may be null.

## summary.json

```json
{
  "models": {
    "parakeet-tdt-0.6b-v3": {
      "n_clips": 15, "mean_wer": 0.23,
      "facts_correct": 30, "facts_wrong": 4, "facts_missing": 6,
      "fact_score": 22
    }
  }
}
```
