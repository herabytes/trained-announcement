# trained-announcement

**Catch the train announcement you missed.** On-device-sized speech models transcribe noisy, human UK rail PA announcements, and an eval harness measures how well (and how fast) they actually do it on real recordings.

**Write-up (1 page):** [`docs/writeup.md`](docs/writeup.md) · [Jump to setup](#setup)

## The problem

On the train, the PA starts firing and you start to think you don't speak English. You completely miss what changes or delays were announced.
Everyone else starts moving (or worse, laughing) and you don't know why!
But your device can help!

### Who it's for / why voice
Voice is the only way live announcements show in many trains. Some operators show live transcriptions on screens (e.g. [Televic](https://www.televic.com/en/rail/solutions/live-transcription-of-announcements)), but not every train service has it. When you're locked in with headphones or sleepy, you completely miss it visually too. #decentralisation 
This is also useful for people who are hard of hearing or are non-native (or non-local) English speakers.


The hard parts for a human, also hard for a transcription model:
- a range of accents (Scottish suffers)
- station names
- ambient train noise - clanking, speech + the garbled channel (PA speaker -> carriage -> phone mic). Signal-to-noise ratio varies
- mobile data on trains is patchy, so it should run locally on a consumer device (how good can small models get?)

## What I built
### 1. Companion to listen, in web and microphone
Essentially stands in for:
- your audio processing neural units (STT model)
- unfamiliar context (context hints / train lingo knowledge)
While fitting on your phone by small size, and only requiring loading journey info (like what Televic does) once before the journey/when you do have good Internet.
For demo's sake this is a web app, you can use the sample clips with preset journeys, or enter your own journey and record your own announcement with a PA simulation.
The audio is then transcribed.


### 2. Evidence that it works
What makes a good transcription? Word accuracy. For trains specifically, it should get key facts the passenger would act on - platform and station names. I only had time to try solve the transcription quality, upstream of facts. I considered denoising, but there is research saying that it hurts quality. The accuracy is also limited by contextual knowledge. I didn't know Conisbrough existed, so the model transcribing it correctly was marked wrong.

*The eval:* scoring a transcription run with word error rate and latency (how long the model takes to transcribe)

*Baseline runs* with small (and fast) models Parakeet, Whisper Small and large Whisper: 
The live human PAs are harder to get right than robotic spliced station announcements by ~3–4 times (median WER: Whisper Small 0.46 vs 0.15, Parakeet 0.88 vs 0.22). Not all drivers are telepresenters and the content is less predictable (e.g. `fs277754`: another unit is about to couple? call? to the rear of the train). This motivates contextual hinting with train vocabulary.
*Context hint run*: 
- Only on Whisper Small because Parakeet doesn't support hints.
- We use a generic list of rail lingo, e.g. *Edinburgh Waverley, ScotRail, "Change here for"* (caveat: the generic list contains stations from the test clips, so generic vs route isn't clean. Needs a re-run with lingo-only)
- We use origin and destination stations to search up stations it might pass on the specific journey.
Results:
-  the generic and route medians are close (0.16 vs 0.14), but route gets the place names not in generic list (Plockton, Kirkcaldy, Inverkeithing...), and didn't made any clip worse (0 regressed). Scoring by key facts should recognise this gain.
- Context helps, but can produce plausible station names where a name is inaudible (`fs317554`: "Swinton", p = 0.03). It didn't invent stations in the wrong places (`fs267700`). Word confidence can flag this but not reliably (PR #9).
- Having a hint also increased the median latency of 0.5s, but helps in one case where Whisper was retrying with randomness 3 times without it, because the initial tries were so bad (clip `fs317554`).
- Running with both generic and route has a tiny median gain. 0.095 vs 0.10 for just route. It fixes `fs44007` to get both "platform 6" and "London Paddington” where route alone said "back on 6th". The Plockton clip dropped the opening "we're now", possible due to randomness, but WER would count that as bad as dropping ‘Plockton’. This is also why we need key-fact scoring eventually.

There is a dashboard for eval results. On the demo you can toggle analysis to see the metrics.


## What I'd do next
Product wise, in a real train scenario there are no clean audio segments, so I will need to implement a ping as wake word, or activate on speech. Still a challenge to detect the onset of PA voice and isolate it, because I've been on trains where people sing I Want It That Way on repeat.
The current context hinting causes hallucinations, which needs investigating. At the minimum, unsure words need to be flagged (Whisper comes with % confidence info). An important measure is scoring key fact accuracy rather than just accuracy, so important things are weighted higher. Then see if WER transcription quality transfers. 
It's also tricky with times, 15:36 and 15:26 sounded very similar. This is where denoising/upsampling? might help for PA in particular, but I haven't tested.
The dataset I've collected is very limited. The number of examples is obviously small because I had to verify transcriptions. As a result, the data isn't as varied and representative. For example, I didn't bother labelling long audios.

Less crucial feature additions:
Come up with features that actually help alert, like classifying the event of delay or cancellation... Maybe an agent can synthesise and decide what the user might need ;) for example, it can decide to alert and buzz when it's your stop next or tell you to look up more routes.
I also can eliminate the live station search with static data because a train station likely doesn't spawn overnight, so selecting from and to should suffice.

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

**Where to look, in order** (after `uv run web/app.py --demo`):
1. **http://127.0.0.1:8000/demo**: the product. The flow: **select a route** (e.g. a preset journey chip, or pick Plockton), play an announcement, then switch on **Analysis** and **Compare** to explore the context hint: each card shows the transcript with vs without the route hint, which words it changed, the WER for each, and the latency for each (what the hint costs in time). Clips without a journey are transcribed without a hint and do not run Compare; with a journey, Compare uses the route hint rather than generic + route, which barely differs from route alone in the evaluation (median WER 0.095 vs 0.10).
2. **http://127.0.0.1:8000/**: the results viewer: baseline per clip, every model side by side.
3. **http://127.0.0.1:8000/regressions**: no hint → route hint, per clip, with a pass/fail gate.
4. **http://127.0.0.1:8000/context**: how the route hint works.

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

| Whisper Small, 9 clips with a known journey | median WER | mean WER |
|---|---|---|
| no hint | 0.30 | 0.36 |
| generic hint | 0.16 | 0.29 |
| **route hint** | **0.14** | **0.19** |

The hint is the clip's own route, e.g. *"Calling at Kyle of Lochalsh, Duirinish, Plockton, … and Inverness."* The journey comes from the clip's Freesound description (never its transcript); the stations come from timetables (`data/route_cache.json`). **Route vs no hint: 5 better, 4 same, 0 worse.** Generic and route medians are close; the route hint's win is place names no generic list has: Plockton, Kirkcaldy, Inverkeithing, Haymarket, Tiverton Parkway, Portsmouth, Stoke-on-Trent, Stockport. The generic list's phrases fixed "platform 6" where the route hint didn't (`fs44007`). A hint full of station names didn't invent stations on an announcement with none (`fs267700`). The hint adds ~0.5 s median transcription time. Caveats: 9 clips; a hint can disturb other words ("to Manchester" → "Dimension of"); on barely-audible `fs317554` it wrote out the whole route, which I could only partly confirm by re-listening. Run: `results/2026-11-11_route_hint` (one run, all three conditions). Try it in the demo: pick Plockton, compare with vs without the route hint.

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
- **Live route lookup for new journeys:** preset journeys use cached routes. New journeys fall back to *"Calling at <origin> and <destination>"* (still fixed Plockton). No LLM needed for the full route: Wikidata's station-adjacency graph gives it with no key (verified on the Far North Line); the Modal LLM version is WIP.
- **Exact train, not just the route:** a train-times API would give the actual service's calling pattern and time (a stronger hint, and a way to check the transcript).
- **LLM post-correction, if context hints aren't enough:** a small language model with railway knowledge repairs the transcript ("call to" → "couple to", see `ai.md`). It costs memory and latency on a phone, so static context hints come first; this is the escalation if they fail.
- Next: streaming transcription, chime/ping activation, key-fact scoring (platform, delay…), denoising front-ends, more accents.

## Data & licences

Audio is not committed (see `.gitignore`); `download_data.py` fetches it. Clips are from [Freesound](https://freesound.org) under CC0 / CC-BY / CC-BY-NC. Per-clip creator, URL and licence are in `data/raw/_fs_ann_meta.json` and `_fs_noise_meta.json` (CC-BY requires attribution). Sources and gaps: `docs/data_sources.md`.

## AI usage

See `ai.md`.
