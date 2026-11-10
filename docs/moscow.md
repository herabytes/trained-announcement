Must have: 1,2,3, 6, 8, 9, 14
Should have: 5, 11, 18
Could have: 10, 12, 13
Would have:4, 7, 15-17

Data
1. Collect ~10–20 real phone clips of announcements from online
2. Hand-label transcript + key facts (station, platform, time, delay, status)
3. metadata.csv manifest (audiofolder format)
4. Record your own train noise
5. Use an existing noise dataset instead (no recording trip needed)

Running models
6. Run 2–3 ASR models on your laptop over the clips
7. Run more models, one per architecture type (CTC / transducer / encoder–decoder / speech-LLM)

Scoring
8. WER
9. Key-fact score, done by hand (+1 correct, −k wrong, 0 missing)
10. LLM judge (you've already said not yet)
18. Per-field fact weights (e.g. wrong platform costs more than wrong delay)

Phase 2: controlled degradation
11. Noise mixing at fixed SNR levels
12. PA channel simulation

Methods to improve
13. Context hints / hotwords (station list)

Later / other
14. Web demo (record → garble → trans
15. End-to-end audio→schema (Gemma etc.)
16. More accents (VCTK, OpenSLR 83, f
17. Running on an actual phone                                                                      