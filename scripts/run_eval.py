# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["onnx-asr[cpu,hub]", "faster-whisper", "whisper-normalizer", "jiwer", "numpy", "av<14"]
# ///
# ^ This block lets `uv run scripts/run_eval.py` install these libraries automatically.
#   av<14: faster-whisper's audio loader breaks on PyAV 14+.
"""Run ASR models over the raw clips and write results/<run_id>/ (format: docs/results_schema.md).

    uv run scripts/run_eval.py --run-id 2026-11-10_v0_first --clips fs267700
    uv run scripts/run_eval.py --run-id 2026-11-10_v0_all          # every announcement clip

The answer key (reference transcripts + trim segments) comes from data/raw/labels.csv,
which the labelling web page writes. Clips without a reference are still transcribed
(wer = null) so you can read what the models heard.
Key facts are not scored yet (facts = [], fact_score = null).
"""
import argparse
import csv
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import jiwer                                     # computes WER via edit-distance alignment
from faster_whisper import decode_audio          # mp3/wav -> numpy array of samples
from whisper_normalizer.english import EnglishTextNormalizer  # lowercase, strip punctuation, "eight"->"8", ...

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DATA_DIR = REPO_ROOT / "data" / "raw"
SAMPLE_RATE = 16000                              # both models expect 16 kHz mono audio
normalise_text = EnglishTextNormalizer()


# ---------------------------------------------------------------------------
# Models. Each wrapper has the same shape: load once in __init__, then
# calling it with an audio array returns the transcript as a string.
# That way the eval loop below doesn't care which model it is talking to.
# ---------------------------------------------------------------------------
class Parakeet:
    name = "parakeet-tdt-0.6b-v3-int8"           # int8 = quantised (smaller, phone-sized)

    def __init__(self):
        import onnx_asr                          # imported here so you only need it if you run this model
        # First call downloads the model from Hugging Face (~hundreds of MB), then it's cached.
        self.model = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", quantization="int8")

    def __call__(self, audio_samples):
        return self.model.recognize(audio_samples, sample_rate=SAMPLE_RATE)


class WhisperSmall:
    name = "whisper-small-int8"

    def __init__(self):
        from faster_whisper import WhisperModel
        self.model = WhisperModel("small", device="cpu", compute_type="int8")

    def __call__(self, audio_samples):
        # Whisper returns the transcript in chunks ("segments"); join them into one string.
        segments, _info = self.model.transcribe(audio_samples, language="en", beam_size=5)
        return " ".join(segment.text.strip() for segment in segments)


class WhisperLargeTurbo(WhisperSmall):
    """~800M params: NOT phone-sized. Used to draft reference transcripts for labelling
    (you still listen + correct), and as an upper-bound comparison."""
    name = "whisper-large-v3-turbo-int8"

    def __init__(self):
        from faster_whisper import WhisperModel
        self.model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")


# Short names you can pass on the command line: --models parakeet whisper-small
AVAILABLE_MODELS = {"parakeet": Parakeet, "whisper-small": WhisperSmall,
                    "whisper-large-turbo": WhisperLargeTurbo}


def read_csv_by_id(csv_path: Path) -> dict:
    """Read a CSV into {clip_id: row}. labels.csv uses 'clip_id', candidates.csv uses 'id'."""
    if not csv_path.is_file():
        return {}
    with csv_path.open(encoding="utf-8", newline="") as f:
        return {row.get("clip_id") or row.get("id"): row for row in csv.DictReader(f)}


def load_clips(clip_ids, audio_files, labels):
    """Decode each clip's audio and trim it to the labelled segment.
    Skips clips you labelled as noise_only / unusable. Returns [(clip_id, audio_samples, label_row)]."""
    clips = []
    for clip_id in clip_ids:
        label = labels.get(clip_id, {})          # {} if you haven't labelled this clip yet
        if label.get("kind") in ("noise_only", "unusable"):
            continue
        audio_samples = decode_audio(str(audio_files[clip_id]), sampling_rate=SAMPLE_RATE)
        seg_start, seg_end = label.get("seg_start"), label.get("seg_end")
        if seg_start or seg_end:                 # seconds -> sample index (seconds * 16000)
            start_index = int(float(seg_start or 0) * SAMPLE_RATE)
            end_index = int(float(seg_end) * SAMPLE_RATE) if seg_end else None
            audio_samples = audio_samples[start_index:end_index]
        clips.append((clip_id, audio_samples, label))
    return clips


def score_wer(reference_norm, hypothesis_norm):
    """WER = (substitutions + deletions + insertions) / words in reference.
    Empty model output = every reference word deleted = 1.0. No reference = can't score (None)."""
    if not reference_norm:
        return None
    if not hypothesis_norm:
        return 1.0
    return round(jiwer.wer(reference_norm, hypothesis_norm), 4)


def main():
    # --- 1. Command-line options ------------------------------------------------
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True, help="name of the results/<run_id>/ folder")
    parser.add_argument("--clips", nargs="*", help="clip ids (default: all announcement clips)")
    parser.add_argument("--models", nargs="*", default=list(AVAILABLE_MODELS))
    args = parser.parse_args()

    # --- 2. Load the answer key + clip info -------------------------------------
    labels = read_csv_by_id(RAW_DATA_DIR / "labels.csv")          # your hand labels
    candidates = read_csv_by_id(RAW_DATA_DIR / "candidates.csv")  # data agent's guesses (accent etc.)
    audio_files = {f.stem: f for f in sorted((RAW_DATA_DIR / "freesound_announcements").glob("*.mp3"))}
    clip_ids = args.clips or list(audio_files)

    clips = load_clips(clip_ids, audio_files, labels)
    print(f"{len(clips)} clip(s)")

    run_dir = REPO_ROOT / "results" / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    # --- 3. The eval loop: every model x every clip -------------------------------
    predictions = []        # one row per (clip, model) -> predictions.jsonl
    summary_by_model = {}   # one row per model         -> summary.json
    for model_key in args.models:
        load_start = time.time()
        model = AVAILABLE_MODELS[model_key]()   # load (and maybe download) the model once
        print(f"loaded {model.name} in {time.time() - load_start:.1f}s")

        wers_for_this_model = []
        wers_by_kind = {}       # e.g. {"human_announcement": [0.43, ...], "automated_announcement": [...]}
        for clip_id, audio_samples, label in clips:
            # 3a. Transcribe, timing only the model call (= transcription latency)
            transcribe_start = time.time()
            hypothesis = model(audio_samples).strip()          # what the model heard
            transcribe_seconds = time.time() - transcribe_start

            # 3b. Compare with the answer key, after normalising both sides
            reference = label.get("transcript") or None        # your label, or None if unlabelled
            reference_norm = normalise_text(reference) if reference else None
            hypothesis_norm = normalise_text(hypothesis)
            wer = score_wer(reference_norm, hypothesis_norm)
            if wer is not None:  # every clip with a transcript is scored, whatever its kind
                wers_for_this_model.append(wer)
                wers_by_kind.setdefault(label.get("kind") or "unlabelled", []).append(wer)

            # 3c. Record everything about this (clip, model) pair
            candidate = candidates.get(clip_id, {})
            predictions.append({
                "clip_id": clip_id,
                "audio_path": audio_files[clip_id].relative_to(REPO_ROOT).as_posix(),
                "model": model.name,
                "reference": reference, "hypothesis": hypothesis,
                "reference_norm": reference_norm, "hypothesis_norm": hypothesis_norm,
                "wer": wer,
                "facts": [], "fact_score": None,              # TODO: key-fact scoring
                "inference_s": round(transcribe_seconds, 2),
                "meta": {
                    "source": "freesound", "channel": "real_recording",
                    "kind": label.get("kind") or None,
                    "noise_level": label.get("noise_level") or None, "snr_db": None,
                    "accent": label.get("accent") or candidate.get("accent_region") or None,
                    "gender": label.get("gender") or None,
                    "type": label.get("status") or None,
                    "duration_s": round(len(audio_samples) / SAMPLE_RATE, 2),
                },
            })
            print(f"  {clip_id} [{transcribe_seconds:.1f}s] wer={wer} | {hypothesis[:90]}")

        # --- 4. Summarise this model ------------------------------------------------
        summary_by_model[model.name] = {
            "n_clips": len(clips),
            "n_with_reference": len(wers_for_this_model),
            "mean_wer": round(sum(wers_for_this_model) / len(wers_for_this_model), 4) if wers_for_this_model else None,
            # Same score split by clip kind: do models find robot voices easier than humans?
            "by_kind": {kind: {"n": len(ws), "mean_wer": round(sum(ws) / len(ws), 4)}
                        for kind, ws in sorted(wers_by_kind.items())},
            "facts_correct": None, "facts_wrong": None, "facts_missing": None, "fact_score": None,
        }
        print(f"  summary by kind: {summary_by_model[model.name]['by_kind']}")

    # --- 5. Save the three files the web frontend reads ------------------------------
    (run_dir / "predictions.jsonl").write_text("".join(json.dumps(p) + "\n" for p in predictions), encoding="utf-8")
    (run_dir / "summary.json").write_text(json.dumps({"models": summary_by_model}, indent=2), encoding="utf-8")
    (run_dir / "run.json").write_text(json.dumps({
        "run_id": args.run_id,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": "data/raw (Freesound announcements)",
        "models": list(summary_by_model),
        "normalizer": "whisper_english (whisper-normalizer)",
        "fact_score_wrong_weight": 2,
        "notes": "first real run; facts not extracted yet",
    }, indent=2), encoding="utf-8")
    print("wrote", run_dir)


if __name__ == "__main__":
    main()
