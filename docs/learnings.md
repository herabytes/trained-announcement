Next time when I have to deal with any data I'm gonna open a Jupyter Notebook first and use pandas. This is too messy. 
- Scot Rail Service - must have a bunch of hard to pronounce names... Language switching broo
- Whisper 30second windows on noise it just decided there is no speech bruh.

## Little experiment: generic context hint (Whisper Small)
- **Setup:** same model (Whisper Small), same 19 clips, only difference = a starting hint (just text prepended before listening: major UK stations, operators, rail phrases).
- **Hypothesis:** giving it *other* UK names won't boost UK names in general, because the hint only boosts those particular words for Whisper. It doesn't know which places are related. So Kirkcaldy and Plockton (not in the list) won't get fixed; Edinburgh Waverley (in the list) might.
- **Result (fair run `2026-11-11_context_vs_base`: both conditions, same 20 clips, same labels, one run):** hypothesis held on names. Edinburgh Waverley (in the list) got fixed (fs65806: "Enver Waverly" → "Edinburgh Waverley"); Kirkcaldy and Plockton (not in the list) didn't ("Carcotti" → "Carcody", Plockton → "Popton"). Human clips: 7 better, 3 same, 0 worse. Automated: 4 better, 4 same, 2 worse:
  - fs44974 (0.43 → 2.60): on stretches it couldn't hear, Whisper **wrote out the hint itself** ("London Paddington, Euston, Newcastle, Glasgow…"). With a hint, noise gets treated as speech and filled with hint words.
  - fs43945 (0.00 → 0.12): the **answer key** is the problem. My label was Whisper Small's draft word for word, including "Tibetan Parkway" (really Tiverton Parkway), so no-hint scored a fake 0.0 by matching its own mistake. ("1st" vs "First" was a false alarm: the normaliser turns both into "1st".) One wrong word out of 41 is only ~0.02, so most of the 0.12 is the hint run's transcript actually changing.
  - **Justice for Parakeet:** it was the *only* model that heard "Tiverton Parkway" right (large-v3-turbo: "Tipperton", Small: "Tibetan"), and the bad key marked it wrong for it. A model-drafted answer key doesn't just flatter the drafter, it punishes whoever disagrees with it, even when they're right. Fixed the label to Tiverton.
  - Caveat: the hint list was written after seeing the clips, so some hint words appear in them (e.g. "first class", "Edinburgh Waverley"): a small head start.
- Earlier, Plockton looked like a big win, but that compared an untrimmed 57 s clip (no hint) with the trimmed 3.7 s clip (hint). In the fair run it's a tie (0.30 vs 0.30). Lesson: compare conditions inside one run.
- Idea: a "skill"-style hint for UK trains, e.g. *"'calling at' is followed by a list of station names"*. Whisper can't use rules like this (its hint is just preceding text, so it would only boost the words "calling at"), but an LLM post-correction step could. Goes with the LLM idea in ai.md.
- Side thought: a slightly butchered name ("Carcotti" for Kirkcaldy) is recoverable for a human who knows their route, but WER counts it as a full error. Missing vs wrong again.

## Sheffield (fs317554): route context helps humans too, but it's unreliable
- First label (no context): "18:36 Northern Rail Service to [inaudible] Calling at Sheffield." Mostly inaudible.
- With the route hint, Whisper wrote out the whole Doncaster → Sheffield route. Copied from the hint, or heard it?
- I re-listened **knowing the route** and heard: "Platform 8 15:36 Northern Rail Service to Sheffield. [inaudible] Highsbrough, Mexbrough, [inaudible], Rotherham Central, Meadowhall and Sheffield. Platform 8 Sheffield."
  - Knowing the route let me hear stations I couldn't before. Context raises the human ceiling too.
  - But it's unreliable: "Highsbrough" is probably Conisbrough, and I can't be sure I'm hearing rather than expecting.
  - Next step: an **exact train API** (the actual service's calling pattern and time), not just "stations on the route".
- **The time is a serious limitation:** the description says 15:26, my old label said 18:36, I now hear 15:36, and **no model got the number at all**. Times and platforms are the facts a passenger needs most, so key-fact scoring (time, platform) matters more than WER here.


## Frontend
Making sure that the frontend doesn't change things from the original python files - the normaliser was different the first go apparently. 

Synthetic data has ground truth that human labels don't because when you have [inaudible] and the model hears superhuman it would be counted as an error of addition.