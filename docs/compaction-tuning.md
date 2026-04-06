# Compaction Tuning Guide

## TLDR — Quick Setup

Lossless Claw compresses your conversation history into summaries so long sessions don't blow the context window or your API bill. On a 200-turn Opus session, proper tuning can cut costs 40-60%.

**Three things to configure:**

1. **Compaction model** — Use a fast, cheap model. Never use your main model.
2. **Skip thresholds** — Prevent unnecessary compaction that wastes your prompt cache.
3. **Chunk size** — How much context to compress per pass.

### Copy-paste configs

**Opus 4.6 (1M context, heavy coding)**
```json
{
  "summaryModel": "claude-sonnet-4-6",
  "summaryProvider": "anthropic",
  "leafChunkTokens": 35000,
  "leafSkipReductionThreshold": 0.02,
  "leafBudgetHeadroomFactor": 0.45
}
```

**Sonnet 4.6 (200K context, general use)** — defaults work well:
```json
{
  "summaryModel": "claude-haiku-4-5",
  "summaryProvider": "anthropic"
}
```

**Haiku 4.5 (quick tasks, 3-10 turns)**
```json
{
  "summaryModel": "claude-haiku-4-5",
  "summaryProvider": "anthropic",
  "leafSkipReductionThreshold": 0.10,
  "leafBudgetHeadroomFactor": 0.90
}
```

**Agent orchestration (main + sub-agents)**
```json
{
  "summaryModel": "claude-sonnet-4-6",
  "summaryProvider": "anthropic",
  "leafChunkTokens": 25000,
  "leafSkipReductionThreshold": 0.02,
  "leafBudgetHeadroomFactor": 0.60
}
```

### Compaction model: the single most important setting

| Do use | Don't use |
|--------|-----------|
| Sonnet 4.6, Haiku 4.5, GPT-4o-mini, Gemini Flash, Mercury | Opus 4.6, o3, any "thinking" model |

**Why:** Compaction runs synchronously in the gateway. A slow model (Opus at 3-8s/call) stalls all connected sessions. A fast model (Haiku at 0.3-0.8s/call) is invisible. Compaction is a straightforward extraction task — expensive models don't produce meaningfully better summaries.

---

## How It Works

### The compaction lifecycle

Every conversation turn follows this sequence:

```mermaid
flowchart LR
    A[Message arrives] --> B[Ingest to DB]
    B --> C[Evaluate leaf trigger]
    C -->|Skip| D[Evaluate full threshold]
    C -->|Compact| E[Leaf pass: summarize oldest chunk]
    E --> D
    D -->|Below threshold| F[Done]
    D -->|Over threshold| G[Full sweep: multi-round compaction]
    G --> F
```

1. **Ingest** — New messages are stored in the database and appended to the context item list.
2. **Leaf trigger** — Checks if raw (unsummarized) messages outside the fresh tail exceed `leafChunkTokens`. If so, evaluates skip guards before compacting.
3. **Full threshold** — Checks if total assembled context exceeds `contextThreshold x tokenBudget`. If so, runs a multi-round full sweep.
4. **Assembly** — When the model needs context, the assembler builds the prompt from summaries + fresh messages, respecting the token budget.

### The summary DAG

Messages are compressed into a hierarchy of summaries:

```
Raw messages (depth -1):
  [msg₁] [msg₂] ... [msg₁₀] [msg₁₁] ... [msg₂₀] [msg₂₁] ... [msg₅₀]

After leaf compaction (depth 0):
  [leaf₁: msgs 1-10] [leaf₂: msgs 11-20] [msg₂₁] ... [msg₅₀]
   ~600 tokens          ~600 tokens         ├── fresh tail ──┤

After condensation (depth 1):
  [condensed₁: leafs 1-3] [leaf₄] [leaf₅] [msg₄₁] ... [msg₅₀]
   ~900 tokens              depth=0          ├── fresh tail ──┤
```

Each tier compresses further. A conversation with 100K raw tokens might be represented as 5K of summaries + 20K of fresh messages — an 80% reduction.

### Cache-aware skip guards

The leaf compaction trigger evaluates three checks in priority order:

```mermaid
flowchart TD
    A["rawTokensOutsideTail >= leafChunkTokens?"] -->|No| Z["No compaction needed"]
    A -->|Yes| B["Assembled tokens < headroom ceiling?"]
    B -->|"Yes (has headroom)"| Y["Skip: budget headroom\nNo pressure, preserve cache"]
    B -->|"No / disabled"| C["Budget pressure detected?"]
    C -->|Yes| E["COMPACT\nBudget pressure overrides cache"]
    C -->|"No (headroom disabled\nor no tokenBudget)"| D["Reduction < 5% of total context?"]
    D -->|Yes| X["Skip: cache-aware\nReduction too small for cache cost"]
    D -->|No| G["COMPACT\nReduction is worthwhile"]

    style E fill:#d4edda
    style G fill:#d4edda
    style Y fill:#fff3cd
    style X fill:#fff3cd
    style Z fill:#f8f9fa
```

**Why this ordering matters:**

1. Budget pressure always wins. If you're approaching the context limit, compaction fires regardless of cache impact.
2. The cache-aware skip only applies when there's no urgency. It prevents tiny compactions (e.g., saving 600 tokens out of 500K) that would bust the prompt cache for negligible gain.
3. Setting either threshold to `0` disables that check entirely.

### Why compaction invalidates the prompt cache

When a leaf pass runs, it:
1. Replaces raw messages (ordinals 0-9) with a single summary (ordinal 0)
2. Resequences all remaining ordinals to stay contiguous (0, 1, 2, ...)
3. The assembled prompt changes structure — the Anthropic/OpenAI cache prefix no longer matches

**Cache miss cost:** On Opus 4.6, a 150K cached prefix costs $1.50/MTok. A cache miss on that prefix costs $15/MTok — a **10x penalty**. One unnecessary compaction can cost $2+ in a single cache miss.

### Timing: when compaction runs

```
Turn lifecycle:
  1. [instant]  Ingest message to DB
  2. [instant]  Evaluate leaf trigger (DB reads only)
  3. [0.3-8s]   Leaf compaction (if triggered) — ASYNC, best-effort
  4. [0.3-60s]  Full sweep (if over threshold) — SYNC, blocks session
  5. [instant]  Return to caller
```

**The critical distinction:**
- **Leaf compaction** runs asynchronously (fire-and-forget). It doesn't block the reply.
- **Full sweep** runs synchronously. It blocks the current session until all passes complete. On a large context with a slow compaction model, this can take 30-60 seconds.

This is why compaction model choice matters so much — a slow model turns full sweeps into visible hangs.

---

## Configuration Reference

### Cache-aware skip settings

| Setting | Default | Env Var | Range | Description |
|---------|---------|---------|-------|-------------|
| `leafSkipReductionThreshold` | `0.05` | `LCM_LEAF_SKIP_REDUCTION_THRESHOLD` | 0-1 | Min per-pass reduction as fraction of total assembled tokens. Set to `0` to disable. |
| `leafBudgetHeadroomFactor` | `0.8` | `LCM_LEAF_BUDGET_HEADROOM_FACTOR` | 0-1 | Skip leaf compaction when assembled tokens < factor x contextThreshold x tokenBudget. Set to `0` to disable headroom check (note: also disables budget pressure detection). |

### All compaction settings

| Setting | Default | Env Var | Description |
|---------|---------|---------|-------------|
| `contextThreshold` | `0.75` | `LCM_CONTEXT_THRESHOLD` | Fraction of budget that triggers full-sweep compaction |
| `leafChunkTokens` | `20000` | `LCM_LEAF_CHUNK_TOKENS` | Max raw tokens per leaf pass |
| `leafTargetTokens` | `2400` | — | Target output tokens for leaf summaries |
| `condensedTargetTokens` | `900` | — | Target output tokens for condensed summaries |
| `freshTailCount` | `64` | `LCM_FRESH_TAIL_COUNT` | Messages protected from compaction |
| `incrementalMaxDepth` | `1` | `LCM_INCREMENTAL_MAX_DEPTH` | Max condensation depth per turn (-1 = unlimited) |
| `leafMinFanout` | `8` | — | Min leaf summaries before condensation |
| `condensedMinFanout` | `4` | — | Min same-depth summaries before condensation |
| `summaryModel` | `""` | `LCM_SUMMARY_MODEL` | Model for compaction (critical — use fast models) |
| `summaryProvider` | `""` | `LCM_SUMMARY_PROVIDER` | Provider for compaction model |
| `summaryTimeoutMs` | `120000` | `LCM_SUMMARY_TIMEOUT_MS` | Timeout per summarization call |
| `leafSkipReductionThreshold` | `0.05` | `LCM_LEAF_SKIP_REDUCTION_THRESHOLD` | Cache-aware skip threshold |
| `leafBudgetHeadroomFactor` | `0.8` | `LCM_LEAF_BUDGET_HEADROOM_FACTOR` | Budget headroom skip factor |

### Recommended configurations by tier

| Scenario | skipThreshold | headroomFactor | leafChunkTokens | summaryModel | Rationale |
|----------|---------------|----------------|-----------------|--------------|-----------|
| **Opus 1M coding** | 0.02 | 0.45 | 35000 | Sonnet/Haiku | At $15/MTok, compact early and aggressively. Larger chunks = fewer cache busts. |
| **Sonnet 200K general** | 0.05 | 0.80 | 20000 | Haiku | Defaults are calibrated here. Break-even ~13.5 turns. |
| **Haiku quick** | 0.10 | 0.90 | 15000 | Haiku | Short sessions rarely recoup cache invalidation. |
| **Orchestration** | 0.02 | 0.60 | 25000 | Sonnet | Sub-agents accumulate fast. Compact early to prevent cascade. |

### Cache economics

| Model | Input $/MTok | Cached $/MTok | Cache miss penalty | Miss on 150K cached |
|-------|-------------|---------------|-------------------|-------------------|
| Opus 4.6 | $15.00 | $1.50 | $13.50/MTok | **$2.03** |
| Sonnet 4.6 | $3.00 | $0.30 | $2.70/MTok | **$0.41** |
| Haiku 4.5 | $0.80 | $0.08 | $0.72/MTok | **$0.11** |

**Break-even formula:** A compaction saving X tokens/turn that invalidates Y cached tokens takes `(Y x miss_penalty) / (X x input_price)` turns to pay back. For typical values (150K cached, 10K saved): **~13.5 turns** regardless of model tier.

### Escape hatches

- `leafSkipReductionThreshold=0` — Disables the cache-aware skip. Compaction fires whenever raw tokens exceed the chunk threshold (original behavior before this feature).
- `leafBudgetHeadroomFactor=0` — Disables the headroom check AND budget pressure detection. Only the cache-aware skip remains active.
- Both set to `0` — Fully disables skip guards. Equivalent to pre-feature behavior.

---

## Advanced: Model Selection and Latency

### Why model choice causes gateway lockups

Compaction calls the LLM to summarize message chunks. Each call:
1. Sends ~20-35K input tokens (the chunk to summarize)
2. Receives ~600-2400 output tokens (the summary)
3. Blocks until complete (full sweep is synchronous)

**Typical latency per compaction call:**

| Model | Latency (20K input) | Cost per call | Gateway impact |
|-------|-------------------|---------------|----------------|
| Haiku 4.5 | 0.3-0.8s | ~$0.02 | Invisible |
| Sonnet 4.6 | 1-3s | ~$0.10 | Brief pause |
| Gemini Flash | 0.5-1.5s | ~$0.03 | Invisible |
| GPT-4o-mini | 0.5-1.5s | ~$0.02 | Invisible |
| **Opus 4.6** | **3-8s** | **~$0.35** | **Visible stall** |
| **o3 / thinking** | **5-30s** | **$0.50-2.00** | **Session timeout** |

A full sweep on a large context may run 5-15 compaction calls. With Opus, that's 15-120 seconds of gateway stall. With a thinking model, it can exceed the 2-minute typing timeout, causing the agent to appear dead.

### What to use

**Always use non-thinking, low-latency models for compaction.** The summarization task (compress conversation into bullet points) does not benefit from chain-of-thought reasoning. Fast models produce equivalent summary quality at 10-50x lower cost and latency.

**Recommended compaction models (in order of preference):**
1. `claude-haiku-4-5` — Best cost/latency ratio for Anthropic users
2. `claude-sonnet-4-6` — Slightly better quality, still fast enough
3. `gpt-4o-mini` — Excellent for OpenAI/OpenRouter users
4. `gemini-2.0-flash` — Good for Google/Vertex users

**Never use for compaction:**
- `claude-opus-4-6` — 5x slower, 5x more expensive, no quality benefit
- Any `o3` / `o1` / thinking model — Chain-of-thought adds 10-30s per call
- `5.4-codex` — Actively corrupts summaries by not following format instructions

### Sub-agent isolation

When compaction runs on the main agent session, it stalls all connected sessions sharing that gateway thread. To prevent this:

1. **Isolate sub-agent sessions** — Configure `ignoreSessionPatterns` or `statelessSessionPatterns` to prevent sub-agents from triggering compaction
2. **Use shorter timeouts** — Set `summaryTimeoutMs` to 30000 (30s) so failed compaction releases the gateway quickly
3. **Choose fast models** — A 0.5s Haiku call is invisible even without isolation

```json
{
  "summaryModel": "claude-haiku-4-5",
  "summaryProvider": "anthropic",
  "summaryTimeoutMs": 30000,
  "ignoreSessionPatterns": ["agent:*:cron:**"],
  "statelessSessionPatterns": ["agent:*:subagent:**"]
}
```

### Debugging compaction issues

**"Compaction never fires"** — Check:
1. Is `leafChunkTokens` set too high? Default is 20K; if your turns are small, raw tokens may never accumulate enough.
2. Is `leafBudgetHeadroomFactor` too high? With a large budget (1M) and default 0.8, the headroom ceiling is 600K — compaction won't fire until then.
3. Enable debug logging to see skip reasons: `[lcm] afterTurn: leaf compaction skipped (budget-headroom: 45000 assembled < 120000 ceiling)`

**"Compaction fires every turn"** — Check:
1. Is `leafChunkTokens` too low? If set to 2000, compaction triggers after just 2-3 messages.
2. Is `leafSkipReductionThreshold` too low or 0? The cache-aware skip might be disabled.
3. Is the context near the budget threshold? Budget pressure overrides all skip guards.

**"Gateway hangs during compaction"** — Check:
1. What model is used for compaction? Switch to Haiku or a mini model.
2. Is `summaryTimeoutMs` set? Default is 120s (2 min) — lower it to 30s for faster release.
3. Is the compaction model returning errors? Check for auth failures (circuit breaker trips after 5 consecutive failures).
