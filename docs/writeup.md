# trained-announcement: write-up

*Same text as the top of the [README](../README.md), which also has setup, results tables and limitations.*

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

### 2. Evidence that it works
Method: what makes a good transcription? Words. Downstream for trains specifically, the key facts the passenger would act on - platform and stuff. I only had time to try solve the transcription quality. I considered denoising, but there is research saying that it hurts. The quality is also limited by context - I didn't know Conisbrough existed, so the model transcribing it was marked wrong. (This was with contexual hinting)
*The eval:* scoring a transcription run with word error rate and latency (how long the model takes to transcribe)
*Baseline runs* with small (and fast) models Parakeet, Whisper Small and large Whisper: 
- the live human PAs are harder than robotic spliced station announcements by ~3–4× (median WER: Whisper Small 0.46 vs 0.15, Parakeet 0.88 vs 0.22). Not all drivers are telepresenters and the content is less predictable (e.g. `fs277754`: a guard explaining another unit is about to couple to the rear of the train, and I'm still not sure of the exact words). Synthetic voices are easier to transcribe ([Walkie benchmark](https://trywalkie.com/en/blog/on-device-speech-to-text-benchmark): 3–6× more errors on a real voice than on computer voices). This holds throughout results. `results/2026-11-11_baseline`
*Context hint run*: 
- It's only Whisper Small because Parakeet doesn't support hints.
- We use a generic list of rail lingo, e.g. *Edinburgh Waverley, ScotRail, "Change here for"*
- We use origin and destination stations to search up stations it might pass on the specific journey.
- Results
-  the generic and route medians are close (0.16 vs 0.14), but route wins in terms of place names not in generic list (Plockton, Kirkcaldy, Inverkeithing...), and didn't made any clip worse (0 regressed)
- Context helps, but can produce plausible station names it couldn't hear (`fs317554`: "Swinton", p = 0.03). It didn't invent stations where there were none (`fs267700`). Word confidence flags some of these, but not reliably (PR #9).
- Having a hint also added a median latency of 0.5s in general, but helps in once case where Whisper was lost retrying without it (clip id fs317554)
- generic + route → happy-ish: median 0.095 vs 0.10 for route alone. It fixes the platform one (`fs44007`: "platform 6" + "London Paddington"; route alone said "back on 6th"). The one "worse" clip is Plockton: it still says **Plockton** and only dropped the filler "we're now", but WER still counts that as worse. **This is why we need key-fact scoring:** WER treats "we're" the same as the station name. (Lingo phrases picked after seeing the clips, so optimistic.) `results/2026-11-11_route_lingo`
There is a dashboard for eval results. On the demo you can toggle analysis to see the metrics.


## What I'd do next
Product wise, in a real train scenario there are no clean audio segments, so I will need to implement a ping as wake word, or activate on speech. Still a challenge to detect the onset of PA voice and isolate it, because I've been on trains where people sing I Want It That Way on repeat.
The current context hinting causes hallucinations, which needs investigating. At the minimum, unsure words need to be flagged (Whisper comes with % confidence info). An important measure is scoring key fact accuracy rather than just accuracy, so important things are weighted higher. Then see if WER transcription quality transfers. 
It's also tricky with times, 15:36 and 15:26 sounded very similar. This is where denoising/upsampling? might help for PA in particular, but I haven't tested.
The dataset I've collected is very limited. The number of examples is obviously small because I had to verify transcriptions. As a result, the data isn't as varied and representative. For example, I didn't bother labelling long audios.

Less crucially:
Come up with features that actually help alert, like classifying the event of delay or cancellation... Maybe an agent can synthesise ;) for example, it can decide to alert and buzz when it's your stop next or tell you to look up more routes.
I also can eliminate the live station search with static data because a train station likely doesn't spawn overnight, so selecting from and to should suffice.
