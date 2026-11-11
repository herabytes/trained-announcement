# trained-announcement

**Catch the train announcement you missed.** On-device-sized speech models transcribe noisy, human UK rail PA announcements, and an eval harness measures how well (and how fast) they actually do it on real recordings.

## The problem

On the train, it pings, and you completely miss what changes or delays were announced.
Everyone else starts moving (or worse, laughing) and you don't know why!
But your device can help!

Some operators show live transcriptions on screens (e.g. [Televic](https://www.televic.com/en/rail/solutions/live-transcription-of-announcements)), but when you're locked in with headphones or sleepy, you completely miss it. And not every train service has it.

The hard parts:
- a range of accents
- ambient train noise, and a bad channel (PA speaker → carriage → phone mic)
- mobile data on trains is patchy, so it should run locally on a consumer device (how good can *small* models get?)

## Who it's for / why voice

<!-- TODO: pick track (Accessibility vs Real-Time Assistance) and tighten this -->
- Passengers whose ears are busy or unavailable: headphones in, asleep, hard of hearing, non-native English speakers.
- The announcement is **voice-only and ephemeral**: you can't scroll back. Turning it into text the moment it ends is the only way to recover it.

## What's in this repo

| Part | What it does |
|---|---|
| `scripts/download_data.py` | Re-downloads the dataset (real announcement recordings from Freesound + train noise) |
| `web/` → `/label` | Labelling page: listen, mark the announcement segment, write the reference transcript |
| `scripts/run_eval.py` | Runs ASR models over the clips, scores WER against your labels, times transcription |
| `web/` → `/` | Results viewer: per-model summary, per-clip transcripts vs reference |

## Setup

Requirements: Python 3.10–3.12 and [uv](https://docs.astral.sh/uv/). Roughly 2 GB free disk for model downloads. CPU only, no GPU needed.

```bash
python scripts/download_data.py --no-demand   # ~45 MB of Freesound clips (drop --no-demand for the 126 MB metro-noise set)
```

## Run

```bash
uv run web/app.py            # results viewer  → http://127.0.0.1:8000
uv run web/app.py --label    # labelling page  → http://127.0.0.1:8000/label

uv run scripts/run_eval.py --run-id my_run                      # all announcement clips, both models
uv run scripts/run_eval.py --run-id my_run --clips fs267700     # one clip
```

First eval run downloads the models (Parakeet TDT 0.6B v3 int8, Whisper Small int8).

## How the eval works

- **Reference (answer key)** = human-verified transcript per clip (`data/raw/labels.csv`). Never a model's output: otherwise the model's mistakes become the answer key.
- Both texts are **normalised** (lowercase, punctuation, number words) before comparing.
- **WER** = (substitutions + deletions + insertions) / reference words. Empty output = 1.0.
- **Latency**: transcription time per clip (`inference_s`).
- Results land in `results/<run_id>/` (`predictions.jsonl` per clip × model, `summary.json` per model).

## Results so far

<!-- TODO: update after labelling + full run -->
| Clip | Model | Output | WER |
|---|---|---|---|
| `fs267700` (Tube driver, iPod recording) | Parakeet TDT 0.6B v3 int8 | "Surely." | 1.00 |
| | Whisper Small int8 | "The train has been held and the signal will be on the move shortly." | 0.43 |

Reference: "The train is being held at a red signal- be on the move shortly". Parakeet transcribes a clean synthetic version of the same sentence perfectly, so the failure is the real-world audio, not the pipeline.

### Failure examples (clip IDs)

From the first full run over unsegmented clips (`results/2026-11-11_v0_all`, `results/2026-11-11_drafts_large`). Anecdotes, not yet measured rates.

| Failure | Clips | What happened |
|---|---|---|
| Real-world channel breaks a small model | `fs267700` | Parakeet: "Surely." on the real recording; perfect on a clean synthetic version of the same sentence |
| Hallucination in non-speech windows (before speech starts / after it ends) | `fs44974`, `fs65805`, `fs277754`, `fs533718` | Whisper writes fluent text that was never said: "Thank you for watching", "Let us know in the comments if you want more", "I don't know what I'm talking about" (repeated). Whisper large-v3-turbo: "Thank you. Thank you. Thank you." |
| Audible to a human, invisible to models | `fs44974` | First 30 s of speech: Whisper rates it "not speech" (no_speech_prob 0.63) and outputs nothing; a standard VAD also finds no speech. A speech-detector trigger would miss this announcement entirely |
| Silent failure | `fs317554`, `fs40156`, `fs95874` | Parakeet returns an empty transcript |
| Place names mangled | `fs65803`, `fs65806`, `fs646162` | Small models: "Kirkcaldy" → "Capote"/"Carcotti", "Edinburgh Waverley" → "Ember Wavelay". Whisper large-v3-turbo gets some right. Hypothesis only: needs a place-name score across many UK stations |

Note: the normaliser deletes `[inaudible]`, so any words a model writes in a gap the labeller couldn't hear count as insertions, even if the model heard correctly. A human-labelled eval can't measure better-than-human hearing.

## Limitations & what's next

<!-- TODO: fill in -->
- Announcements with **long pauses** aren't handled: we don't yet detect when an announcement has really ended (endpointing).
- Small dataset, hand-labelled; accents/noise not yet balanced.
- **Most clips are real recordings, but not phone recordings**: Freesound field recordings mostly made on dedicated recorders (Zoom H1/H4/H4N, Olympus + condenser mics, binaural mics, minidisc); only 2 on consumer devices (iPod touch, smartphone). Freesound's auto-classifier files some under Speech > Processed / Synthetic. Real passenger phone audio is mono, compressed and noisier, so these results are likely **optimistic**.
- **Old recordings:** most Freesound clips are from its early years (roughly 2007–2010 judging by upload IDs; one description says August 2002), made with older recorders. Some clips with plenty of audible speech (e.g. `fs44974`) are judged "not speech" by every model and by a standard voice-activity detector. Newer passenger phone recordings (YouTube/TikTok, licensing permitting) would be more representative, and probably cleaner.
- **Some references are imperfect:** where a model draft couldn't be confirmed by listening it was deleted (e.g. the opening of `fs65805`); `fs638928`'s place name is unknown and kept as heard ("Lutzenkinsen"), so that word's score is unreliable.
- **Trim clips to the announcement (endpointing):** hallucinations appear in the non-speech stretches before and after the announcement, so trimming should cut them as well as latency.
- **Route-aware contextual biasing:** build the model's hint from the passenger's journey (the train's calling points), instead of a generic UK-rail list.
- Next: streaming transcription, chime/ping activation, key-fact scoring (platform, delay…), denoising front-ends, more accents.

## Data & licences

Audio is not committed (see `.gitignore`); `download_data.py` fetches it. Clips are from [Freesound](https://freesound.org) under CC0 / CC-BY / CC-BY-NC. Per-clip creator, URL and licence are in `data/raw/_fs_ann_meta.json` and `_fs_noise_meta.json` (CC-BY requires attribution). Sources and gaps: `docs/data_sources.md`.

## AI usage

See `ai.md`.
