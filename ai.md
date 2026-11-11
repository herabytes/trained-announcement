# How I used AI

**Tools:** Claude Code (Claude Opus 5.5) as the main collaborator; Claude subagents for parallel jobs; Gemini once, for labelling context.

## 1. Opus for execution: Claude Code writes it, but I understand it
- Claude Code wrote most of the code (eval script, labelling page, results viewer, demo, route hint), ran the evals and handled git. I drove: I picked the problem, the priorities (MoSCoW) and the product design.
- I asked it to **hold my hand so I actually learn how it works**: e.g. walk me through `run_eval.py` step by step (with a diagram of which functions run), explain the normalised diff on a real clip, and explain git (add / commit / push / PR) "like showing a little child".
- I wrote my own first scoring function (count reference words the model missed) before switching to `jiwer`, so I knew what WER was doing.
- I asked it to **show me every file that exists** and to confirm with me before creating new ones: I can't have files in my project that I don't know about.
- It quizzed me on what had just happened after each step, so I wasn't just accepting output.

## 2. Subagents: outsourced work I already know how to do
Subagents are my outsourced front-end and that sort of work: things I've done before and know work. That keeps the overall project vision in one place (the main chat) so I don't get overwhelmed.
- **Front end:** results viewer, demo build and redesign, journey filter
- **Data:** sourcing and documenting the Freesound recordings
- **Audit:** a read-only check of every number we show (it caught the stale baseline)
- **Regression lens:** used as a black box, because I'd established the basics first
- **Side experiments:** e.g. route + rail lingo, open station data. I trusted those results because each task was very specific, and I reviewed every report before merging.

## 3. Questioning me on design choices
I asked Claude to quiz me instead of deciding for me, and to correct me when I was wrong. Decisions I made and can defend: a human-verified answer key (not model output), wrong is worse than missing, medians because of outliers, compare conditions inside one run, route-based context instead of a generic list.
- Without that, I'd have gone with my first instinct: **"just use a bigger model for the answer key"**. It made me work out why that grades models against another model's mistakes.

## How I prompt
Phrases I actually used in this project:
- **Research:** "help me with the research", "do a little research, just one paragraph", "look it up". I want a short summary with sources, not an essay.
- **Learning:** "make me give the reasoning and correct me", "quiz me on what just happened", "let's go slower, I want to be thinking", "pretend you're showing a little child".
- **Trust:** "I don't want to do anything because the agent told me so", "when you show a surprising result, show me the data".
- **Control:** "confirm before you write a new file", "set up your questions better, do one thing at a time", "use the question tool for questions".
- **Speed:** "delegate coding to subagents when you can", "what's the new plan, minimum to a README".
- **Perspective:** "what would Daren say?" (checking my work against what the Hiya engineer told me he cares about).

## 4. Research
Claude searched and summarised sources with links I could check: small open ASR models and on-device benchmarks (to pick phone-sized models), papers on denoising before ASR (why I parked denoising), Whisper prompting practice (why the hint is short and exactly spelled), and open UK station data (Wikidata, for looking up routes without an LLM).

## Labelling: LLM for context, audio has the final say
When a draft transcript didn't make sense, I asked Gemini what it probably meant in railway context, then **re-listened** and kept only what I could hear. Example (`fs277754`): "the unit is about to **call to** the rear" → probably "**couple to**" (another train attaching). Context raises the ceiling for humans too.

## Mistakes the AI made that I (or the audit) caught
- A "huge win" on Plockton compared different audio (57 s vs 3.7 s): a tie when compared fairly.
- "A bigger model doesn't help on human clips" came from means dragged by one outlier; by median it does.
- The generic hint started with "UK train announcement.", which does nothing (Whisper's hint isn't an instruction).
- Model-drafted answer keys flattered the drafter's mistake and punished the model that got it right (Tiverton Parkway).
