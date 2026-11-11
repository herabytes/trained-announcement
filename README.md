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
| `web/` → `/demo` | **The product demo**: journey → play or speak an announcement → live transcript (optionally through a simulated train PA) |
| `scripts/download_data.py` | Re-downloads the dataset (real announcement recordings from Freesound + train noise) |
| `web/` → `/label` | Labelling page: listen, mark the announcement segment, write the reference transcript |
| `scripts/route_hint.py` | Journey → stations on the route (static: `data/route_cache.json`) → Whisper hint "Calling at A, B and C." The demo does **no live lookup**: journeys not in the static file get a partial hint of just origin and destination. A static station/timetable database is planned to replace the file; `deploy/route_lookup.py` (Modal) was an unmaintained experiment. |
| `scripts/run_eval.py` | Runs ASR models over the clips, scores WER against your labels, times transcription |
| `web/` → `/` | Results viewer: per-model summary, per-clip transcripts vs reference |

## Setup

Requirements: Python 3.10–3.12 and [uv](https://docs.astral.sh/uv/). Roughly 2 GB free disk for model downloads. CPU only, no GPU needed.

```bash
python scripts/download_data.py --no-demand   # ~45 MB of Freesound clips (drop --no-demand for the 126 MB metro-noise set)
```

## Run

```bash
uv run web/app.py --demo     # live demo       → http://127.0.0.1:8000/demo   (start here)
uv run web/app.py            # results viewer  → http://127.0.0.1:8000   (/regressions: before vs after per clip, pass/fail gate; /context: how the route hint works)
uv run web/app.py --label    # labelling page  → http://127.0.0.1:8000/label

uv run scripts/run_eval.py --run-id my_run                      # all announcement clips, both models
uv run scripts/run_eval.py --run-id my_run --clips fs267700     # one clip
```

The first transcription downloads Whisper Small (~500 MB, one-off); the first eval run also downloads Parakeet TDT 0.6B v3 int8.

**Demo:** type your journey, then either pick a recorded announcement (Recommended clips first) and press *Transcribe this clip*, or press **● Record**, read an announcement aloud, and **■ Stop**. Tick *Simulate train* to hear your voice through a PA speaker with carriage noise, and see what the model makes of it. Allow microphone access when the browser asks.

## How the eval works

- **Reference (answer key)** = human-verified transcript per clip (`data/raw/labels.csv`). Never a model's output: otherwise the model's mistakes become the answer key.
- Both texts are **normalised** (lowercase, punctuation, number words) before comparing.
- **WER** = (substitutions + deletions + insertions) / reference words. Empty output = 1.0.
- **Latency**: transcription time per clip (`inference_s`).
- Results land in `results/<run_id>/` (`predictions.jsonl` per clip × model, `summary.json` per model).

## Results

WER, lower = better, shown as **median (mean)**: a few clips where a model invents text (WER > 1) dominate the means. 20 hand-labelled clips (10 human, 10 automated); per-clip results are in the viewer.

### 1. Baseline

| | automated | human | median time per clip (laptop CPU) |
|---|---|---|---|
| Parakeet TDT 0.6B v3 int8 (phone-sized) | 0.22 (0.32) | 0.88 (0.82) | 2.0 s |
| Whisper Small int8 (phone-sized) | 0.15 (0.22) | 0.46 (0.85) | 4.1 s |
| Whisper large-v3-turbo int8 (~3× bigger) | **0.02** (0.15) | **0.37** (0.51) | 15.5 s |

**Human announcements are much harder for every model.** By median, a bigger model helps on both kinds, at 4–8× the time. Parakeet, the fastest, is worst on human clips (it often outputs nothing). Runs: `results/2026-11-11_baseline`, `results/2026-11-11_baseline_large`.

### 2. Context hint: generic UK-rail list (Whisper Small)

| Whisper Small | automated | human |
|---|---|---|
| no hint | 0.15 (0.22) | 0.45 (0.81) |
| generic hint | 0.15 (0.37) | **0.32** (0.57) |

Same model, same clips, one run (branch `exp/context`, `results/2026-11-11_context_vs_base`). **Helps on human clips** (7 better, 3 same). It fixes names that are in the list ("Enver Waverly" → "Edinburgh Waverley") but not others (Kirkcaldy, Plockton). On stretches it can't hear, Whisper sometimes **writes out the hint itself** (`fs44974`). Caveat: the list was written after seeing the clips, so a few hint words appear in them.

### 3. Context hint: journey-specific (Whisper Small)

| Whisper Small, 6 clips with a known journey | median WER | mean WER |
|---|---|---|
| no hint | 0.23 | 0.40 |
| generic hint | 0.21 | 0.33 |
| **route hint** | **0.09** | **0.16** |

The hint is the clip's own route, e.g. *"Calling at Kyle of Lochalsh, Duirinish, Plockton, … and Inverness."* The journey comes from the clip's Freesound description (never its transcript); the stations come from timetables (`data/route_cache.json`). **It fixed every place name the generic list missed:** Plockton, Kirkcaldy, Inverkeithing, Haymarket, Tiverton Parkway, Stoke-on-Trent, Stockport. Caveats: only 6 clips; a hint can disturb other words ("to Manchester" → "Dimension of"); and on `fs317554`, which is barely audible, it wrote out the whole route: re-listening *knowing the route*, I could hear most of it, but couldn't fully confirm it (a human-labelled eval can't measure beyond the labeller). Run: `results/2026-11-11_route_hint` (one run, all three conditions). Try it in the demo: pick Plockton, compare with vs without the route hint.

**Reproduced from a fresh clone** (clone → `download_data.py` → `uv run web/app.py`): Plockton without hint → "Popton", with route hint → "Plockton". No API key needed (routes are cached).

### Failure examples (clip IDs)

Mostly from the first full run over *unsegmented* clips (`results/2026-11-11_v0_all`, `results/2026-11-11_drafts_large`). Anecdotes, not measured rates.

| Failure | Clips | What happened |
|---|---|---|
| Real-world channel breaks a small model | `fs267700` | Parakeet: "Surely." on the real recording ("The train is being held at a red signal…"); perfect on a clean synthetic version of the same sentence |
| Hallucination in non-speech windows (before speech starts / after it ends) | `fs44974`, `fs65805`, `fs277754`, `fs533718` | Whisper writes fluent text that was never said: "Thank you for watching", "Let us know in the comments if you want more", "I don't know what I'm talking about" (repeated). Whisper large-v3-turbo: "Thank you. Thank you. Thank you." |
| Audible to a human, invisible to models | `fs44974` | First 30 s of speech: Whisper rates it "not speech" (no_speech_prob 0.63) and outputs nothing; a standard VAD also finds no speech. A speech-detector trigger would miss this announcement entirely |
| Silent failure | `fs317554`, `fs40156`, `fs95874` | Parakeet returns an empty transcript |
| Place names mangled | `fs65803`, `fs65806`, `fs646162` | Small models: "Kirkcaldy" → "Capote"/"Carcotti", "Edinburgh Waverley" → "Ember Wavelay". Whisper large-v3-turbo gets some right |

## Limitations & what's next

- Announcements with **long pauses** aren't handled: we don't yet detect when an announcement has really ended (endpointing).
- Small dataset, hand-labelled; accents/noise not yet balanced.
- **Labelled clips aren't a representative sample:** with limited time I labelled the clearest clips and a few outrageous failures first, and skipped most of the long ones. The hardest real-world cases are under-represented, so real-world WER is likely higher. With more time: label a random (or stratified by length/noise/accent) sample, including the long and garbled clips.
- **Most clips are real recordings, but not phone recordings**: Freesound field recordings mostly made on dedicated recorders (Zoom H1/H4/H4N, Olympus + condenser mics, binaural mics, minidisc); only 2 on consumer devices (iPod touch, smartphone). Freesound's auto-classifier files some under Speech > Processed / Synthetic. Real passenger phone audio is mono, compressed and noisier, so these results are likely **optimistic**.
- **Old recordings:** most Freesound clips are from its early years (roughly 2007–2010 judging by upload IDs; one description says August 2002), made with older recorders. Some clips with plenty of audible speech (e.g. `fs44974`) are judged "not speech" by every model and by a standard voice-activity detector. Newer passenger phone recordings (YouTube/TikTok, licensing permitting) would be more representative, and probably cleaner.
- **Some references are imperfect:** where a model draft couldn't be confirmed by listening it was deleted (e.g. the opening of `fs65805`); `fs638928`'s place name is unknown and kept as heard ("Lutzenkinsen"), so that word's score is unreliable.
- **Some answer keys started as model drafts** (`draft_used` in `labels.csv`): a draft kept word-for-word favours the model that wrote it (mostly Whisper large). E.g. `fs43945` keeps the draft's "Tibetan Parkway" (really Tiverton Parkway), so no-hint Whisper Small scores a "perfect" 0.0 by matching its own mistake. Next: re-check draft-derived references against the audio, or report a subset without drafts.
- **`[inaudible]` counts against models:** the normaliser deletes it, so words a model writes in a gap the labeller couldn't hear count as insertions, even if the model heard correctly. A human-labelled eval can't measure better-than-human hearing.
- **Whisper isn't fully repeatable:** when its output looks repetitive or unsure, it retries with some randomness. Same audio, `fs317554`, Whisper large: WER 4.89 in one run, 1.00 in the next.
- **Trim clips to the announcement (endpointing):** hallucinations appear in the non-speech stretches before and after the announcement, so trimming should cut them as well as latency.
- **Numbers get lost:** on `fs317554` no model got "Platform 8, 15:36", the facts a passenger needs most. WER treats them like any word; key-fact scoring (time, platform, destination) is the next metric.
- **Exact train, not just the route:** a train-times API would give the actual service's calling pattern and time (a stronger hint, and a way to check the transcript).
- **Route-aware contextual biasing:** build the model's hint from the passenger's journey (the train's calling points), instead of a generic UK-rail list.
- **LLM post-correction, if context hints aren't enough:** a small language model with railway knowledge repairs the transcript ("call to" → "couple to", see `ai.md`). It costs memory and latency on a phone, so static context hints come first; this is the escalation if they fail.
- Next: streaming transcription, chime/ping activation, key-fact scoring (platform, delay…), denoising front-ends, more accents.

## Data & licences

Audio is not committed (see `.gitignore`); `download_data.py` fetches it. Clips are from [Freesound](https://freesound.org) under CC0 / CC-BY / CC-BY-NC. Per-clip creator, URL and licence are in `data/raw/_fs_ann_meta.json` and `_fs_noise_meta.json` (CC-BY requires attribution). Sources and gaps: `docs/data_sources.md`.

## AI usage

See `ai.md`.
