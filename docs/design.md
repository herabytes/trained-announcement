Input: garbled audio
Output: clearer text


Usable wrapper demo:
record a ping activation -> voice into it -> garble it up fake -> clear text


Main engine:
Take a recording, run it through a model, check transcription accuracy
The question is: at what point does garbled audio become impossible to transcribe, and what can we do to help?
And how well can we do it locally?

Experiment setup:
Need real data. Not automated UK rail announcements at stations, the real problematic audio is human.
We need a range of scenarios and accents for the eval, so we know how much of what works first.

The Local Question:
Latency to ping a server with small audio is fine, a few seconds to transcripbe. 
We cannot use things too big, 0.6B parameters apparently ok
┌──────────────────────┬───────────────┬────────────────────────┐
│        Model         │ Download size │ Time for 30 s of audio │
├──────────────────────┼───────────────┼────────────────────────┤
│ Moonshine Tiny       │ ~125 MB       │ 1.4 s                  │
├──────────────────────┼───────────────┼────────────────────────┤
│ SenseVoice Small     │ ~240 MB       │ 1.7 s                  │
├──────────────────────┼───────────────┼────────────────────────┤
│ Whisper Tiny         │ ~100 MB       │ 2.1 s                  │
├──────────────────────┼───────────────┼────────────────────────┤
│ Parakeet TDT 0.6B v3 │ ~670 MB       │ 2.8 s                  │
├──────────────────────┼───────────────┼────────────────────────┤
│ Whisper Small        │ ~490 MB       │ 12.3 s                 │
├──────────────────────┼───────────────┼────────────────────────┤
│ Qwen3-ASR 0.6B       │ ~1.9 GB       │ 15.9 s                 │
├──────────────────────┼───────────────┼────────────────────────┤
│ Whisper Turbo        │ ~1.0 GB       │ 17.9 s                 │
└──────────────────────┴───────────────┴────────────────────────┘
Implementation on a phone is also varying in latency.

Warning: we might not get anywhere usable. However, we can set up evals on real train scenarios to see some steps towards improvement.Walkie's test - bad on real voice, more errors for UK English...


Methods to try - implement then run eval then merge if better
- hotwords, contextual biasing (televic did that too with train context, source: video) "Use the closed vocabulary. Station names, operators and "platform N" form a known, finite list. Hotword or contextual biasing (sherpa-onnx supports this for transducer models like Parakeet and Zipformer), or post-correction against the route's station list, is probably your best cheap way to handle accents. This is speculation on my part, but it could easily beat moving up a model size." don't claim before testing that moving up model size



The actual eval:
Different from plain transcription % accuracy by words. We can do LLM-as-a-judge (need it or nah?) for whether or not key information was conveyed. Well, extracting ground truth key info needs LLM at scale probably.
