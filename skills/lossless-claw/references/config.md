# Configuration

`lossless-claw` is most effective when the operator understands which settings change compaction behavior and why.

## First checks

- Ensure the plugin is installed and enabled.
- Ensure the context-engine slot points at `lossless-claw` when you want it to own compaction.
- Run `/lossless` (`/lcm` alias) to confirm the plugin is active and see the live DB path.

## Settings That Matter Most

### `contextThreshold`

Controls how full the model context can get before LCM compacts older material.

- Lower values compact earlier.
- Higher values compact later.

Why it matters:

- Too low increases summarization cost and churn.
- Too high risks hitting the model window with large tool output or long replies.

Good default:

- `0.75`

### `freshTailCount`

Keeps the newest messages raw instead of compacting them.

Why it matters:

- Higher values preserve near-term conversational nuance.
- Lower values free context budget sooner.

Good starting range:

- `32` to `64`

### `leafChunkTokens`

Caps how much raw material gets summarized into one leaf summary.

Why it matters:

- Larger chunks reduce summarization frequency.
- Smaller chunks create more summaries and more DAG fragmentation.

Use this when:

- Your summarizer is rate-limited or expensive.
- You want fewer but broader leaf summaries.

### `incrementalMaxDepth`

Controls how far automatic condensation cascades after leaf compaction.

Why it matters:

- `0` keeps only leaf summaries moving automatically.
- `1` is a practical default for long-running sessions.
- `-1` allows unlimited cascading, which can be useful for very long histories but is more aggressive.

### `summaryModel` and `summaryProvider`

Overrides the model used for compaction summarization.

Why it matters:

- Summary quality compounds upward in the DAG.
- Cheaper models can reduce cost, but weak summaries create weak recalled context later.

Guidance:

- Pick a cheaper model only if it remains reliably structured and faithful.

### `expansionModel` and `expansionProvider`

Overrides the model used by delegated recall flows such as `lcm_expand_query`.

Why it matters:

- This lets recall-heavy work use a different cost/latency profile than normal compaction.

## Session controls

### `ignoreSessionPatterns`

Use this for sessions that should never enter LCM at all.

Why it matters:

- Keeps low-value automation or noisy sessions out of the DB.

### `statelessSessionPatterns`

Use this for sessions that may read from LCM but should not write to it.

Why it matters:

- Useful for sub-agents and ephemeral workers.
- Prevents recall helpers from polluting the main history.

## Practical operator workflow

1. Install and enable the plugin.
2. Set the context-engine slot to `lossless-claw`.
3. Start with conservative defaults.
4. Run `/lossless` after startup to confirm path, size, and summary health.
5. If recall feels weak, revisit `freshTailCount`, `leafChunkTokens`, and summarizer model quality before changing anything else.

## Reading the status output

`/lossless` is the right command for LCM-local metrics.

Useful interpretation notes:

- `LCM frontier tokens` (or similarly named frontier/context metric) is the token count of what LCM currently has active in its frontier.
- `compression ratio` is shown as a rounded `1:N`, which is easier to read than a tiny percentage for heavily compacted conversations.
- `/status` may still show a different context number because it reflects the runtime prompt that was actually assembled and sent on the last turn.
