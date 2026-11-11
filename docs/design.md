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
- denoising techniques



# The actual eval:
Different from plain transcription % accuracy by words. We can do LLM-as-a-judge (need it or nah?) for whether or not key information was conveyed. Well, extracting ground truth key info needs LLM at scale probably. "Change the metric. Overall WER matters less than getting the key facts right: station, platform, minutes of delay, cancelled or not. Score those fields directly. That also answers your question "at what point does it become impossible?" more usefully."

Missing info vs wrong info:
Given enough context, you could recover from a missing piece by asking someone. If a number is wrong and you trust it, that's worse. This is important for our benchmark.

The eval score is from the transcript - how many facts it extracts weighted by how much getting it wrong matters. + for correct, - for missing, -- for wrong.

## The data's structure
Audio clips with labels, transcripts...
Freesound descriptions sometimes contain ground-truth transcripts, or are titled with the station name, so those could be used as the 'answer key'.

I will label some data.

We avoid letting the model grade its own work, i.e. generate transcript using Whisper and grade the Whisper result. Even if it's a different model, it's not useful if the answer key is wrong, it just compares mistakes.



## Running an eval
`run_eval` has polymorphic classes, takes in the clips and labels, filters out unusable audio, decodes it. The hypothesis = model output, reference = the transcript. `jiwer` handles the edit distance algorithm to calculate WER = (Substitutions + Deletions + Insertions) ÷ words in the reference.
Whisper's normaliser handles formatting.
With the csv, we run each model on all the audio clips with transcripts labelled.

# How to improve this
We can try improve WER or improve the key facts. If key facts is good enough, we stop, but WER is upstream of key facts. I would want to weight key information more rather than plain WER in the eval. 
Research shows that denoising can hurt ASR due to models being trained on noisy audio, so it would be OOD or something. Neural denoisers may add artifacts.
Speaker separation could help on cases where people are talking on the train and we're trying to isolate just the garbled announcement voice.
The denoising experiment
Simple EQ-style spectral gater just to tone down the noise, a bit like whatever Audacity does to learn the noise profile. On trains this is the engine hum, and the clanking. `noisereduce` is a small library that does the job.

The experiment is to run the same thing but with the denoising step. We see WER change and latency change. Then we can conclude something.

The better experiment is definitely giving it place name and train lingo bias. Might need to pull data from this.
We currently just plug 'context' into Whisper-small-context with some common phrases and place names, relative to UK rail. Realistically this would pull from the passenger's train info input.