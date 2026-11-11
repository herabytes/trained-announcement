# implementation plan

Goal: find out which factors (noise, channel, accent, ...) break small ASR models first on UK train announcements, and how far we can push them. Target: runs on a laptop (web demo) / fits on a phone. Latency doesn't matter (clips are 5-30 s).

## Phase 0 - real clips first (v0 dataset)

Start with what already exists: real people's phone recordings of train announcements found online (incl. funny ones).
- [ ] Collect ~10-20 clips (keep source URL; don't commit audio to the repo - `data/` stays local / gitignored)
- [ ] Trim each to one announcement
- [ ] Hand-annotate (tractable at this size):
  - transcript - mark genuinely unclear words as `[inaudible]` instead of guessing
  - key facts: station(s), platform, time, delay minutes, status (delayed / cancelled / changed / ...)
  - metadata: accent (best guess), gender, rough noise level (low / med / high), channel = `real_phone`
- [ ] Optional: use a heavy model (e.g. Qwen3-ASR-1.7B / Whisper large-v3) to *draft* transcripts, then correct by hand. Never use the heavy model's output as ground truth directly (we'd be grading against a model).

Note: viral clips are biased (often clear, unusual content). Unusual content is useful: the model can't guess it from expectation, so it tests hallucination.

## Phase 1 - eval harness (laptop)

- [ ] Load dataset via HF `load_dataset("audiofolder", data_dir="data/v0")`
- [ ] Run a spread of models, one per "how much does the writer guess" level:
  - CTC: SenseVoice Small
  - Transducer: Parakeet TDT 0.6B v3
  - Encoder-decoder: Whisper Small, Moonshine v2 (small/medium)
  - Speech-LLM: Qwen3-ASR-0.6B/1.7B or Gemma 4 E2B
- [ ] Metrics:
  - WER (vs hand transcript)
  - **Key-fact score** per field: correct / missing / **wrong** (wrong is worse than missing)
  - **Hallucination**: content produced where the reference is `[inaudible]`, or confident wrong facts
- [ ] With vs without context hints (station list / "UK rail announcement" prompt / hotwords) - same model, does context help?

Research question: as noise rises, does more language-model guessing help (filling gaps) or hurt (inventing facts)?

## Phase 2 - controlled conditions

Take the cleanest clips (+ any clean read-script recordings) and degrade them in a controlled way.

- [ ] Record train ambient noise (several trains; moving / stopped)
- [ ] Mixing script: SNR in {clean, 10, 5, 0, -5} dB
- [ ] **Channel** simulation (important): `direct` (clean mic) / `pa_sim` (band-pass + reverb + clipping) / `real_phone` (from Phase 0)
- [ ] Ground truth carries over from the source clip - no re-annotation needed

Priority of variables: 1. noise (SNR)  2. channel  3. accent. Gender + duration = metadata only. Announcement type = optional tag, not a controlled factor.

Don't build the full grid. Grow along whichever axis breaks models first.

## Phase 3 - widen accents (later)

- [ ] Friends reading scripted announcements in their accents (consented, transcript known)
- [ ] Public read-speech with UK accents: VCTK (CC BY 4.0), OpenSLR 83 (UK/Ireland dialects), Common Voice

## Dataset format

HF audiofolder: `data/<version>/` containing `a0001.wav, a0002.wav, ...` + `metadata.csv`. Short IDs as filenames; all variables live in the manifest (not the filename).

```
file_name,source,source_url,channel,snr_db,noise_level,accent,gender,type,duration_s,transcript,station,platform,time,delay_min,status,label_method
a0001.wav,online,https://...,real_phone,,high,glaswegian,m,delay,14.2,"...",Glasgow Central,,,10,delayed,hand
```

- `snr_db`: only for mixed clips (empty for real recordings - use `noise_level` estimate instead)
- `label_method`: `hand` / `model_draft_hand_corrected`
