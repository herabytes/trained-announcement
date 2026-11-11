# How I used AI

**Tools:** Claude Code (Claude Opus 5.5) as the main collaborator; Claude subagents for parallel jobs; Gemini once, for labelling context.

## 1. Opus for execution
Claude Code wrote most of the code (eval script, labelling page, results viewer, demo, route hint), ran the evals, and handled git. I drove: I picked the problem, the priorities (MoSCoW) and the product design, and had it walk me through `run_eval.py` line by line (I wrote my own first scoring function before switching to `jiwer`).
✏️ *(your words: how you directed it, what you changed or rejected)*

## 2. Subagents for parallel work
Separate Claude instances ran jobs in the background while I worked: sourcing the Freesound data, building and redesigning the demo, a **read-only audit** of every number shown, the regression page, research (open station data, Whisper prompting), and side experiments. I reviewed every report before anything was merged.
✏️ *(your words: e.g. the audit that caught the stale baseline)*

## 3. Questioning me on design choices
I asked Claude to quiz me instead of deciding for me. Decisions I made and can defend: a human-verified answer key (not model output), wrong is worse than missing, medians because of outliers, compare conditions inside one run, route-based context instead of a generic list.
✏️ *(your words: one question that changed your mind)*

## Labelling: LLM for context, audio has the final say
When a draft transcript didn't make sense, I asked Gemini what it probably meant in railway context, then **re-listened** and kept only what I could hear. Example (`fs277754`): "the unit is about to **call to** the rear" → probably "**couple to**" (another train attaching). Context raises the ceiling for humans too.

## Mistakes the AI made that I (or the audit) caught
- A "huge win" on Plockton compared different audio (57 s vs 3.7 s): a tie when compared fairly.
- "A bigger model doesn't help on human clips" came from means dragged by one outlier; by median it does.
- The generic hint started with "UK train announcement.", which does nothing (Whisper's hint isn't an instruction).
- Model-drafted answer keys flattered the drafter and punished the right model (Tiverton Parkway).
