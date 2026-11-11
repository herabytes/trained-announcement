# AI usage

## Tools used

- **Claude Code (Claude Opus 5.5)**: TODO: what it did and what I decided myself.
- **Gemini (Google)**: help understanding announcements while labelling (below).

## Labelling: LLM help with context, audio has the final say

Some reference transcripts in `data/raw/labels.csv` were made with LLM help:

1. A big model (Whisper large-v3-turbo) drafted the transcript.
2. When the draft didn't make sense to me, I pasted it into Gemini to ask what the announcement probably meant in railway context.
3. **I re-listened** with that in mind and kept only words I could actually hear; anything else became `[inaudible]`.

The LLM only suggested; it never heard the audio and never wrote a reference directly. This isn't tracked per clip.

**Example (`fs277754`):** the draft said *"The unit is about to **call to** the rear of this train"*, which made sense to me, so I had accepted it. Gemini pointed out it's almost certainly *"couple to"*: another train unit physically attaching to the back, which is why the doors close and then reopen.

**Finding:** a labeller without railway knowledge mis-heard "couple to" as "call to"; a text-only LLM with railway knowledge fixed it without hearing anything. **Context raises the ceiling for humans as well as for models.** Human-verified references are only as good as the labeller's domain knowledge.
