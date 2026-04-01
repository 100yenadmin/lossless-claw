# Diagnostics

For the MVP, use the native command surface first.

## Fast path

### `/lcm`

Use this when you need a quick health snapshot.

It should answer:

- Is `lossless-claw` enabled?
- Is it selected as the context engine?
- Which DB is active?
- Is the DB growing as expected?
- Are summaries present?
- Are broken or truncated summaries present?

### `/lcm doctor`

Use this when summary corruption or truncation is suspected.

It is the single user-facing diagnostic entrypoint for summary-health issues in the MVP.

What it should help confirm:

- whether broken summaries exist
- whether truncation markers exist
- which conversations are affected most

## Interpreting common states

### No summaries yet

Usually means one of:

- the conversation has not crossed compaction thresholds yet
- the plugin is not selected as the context engine
- writes are being skipped because the session matches stateless or ignored patterns

### DB exists but stays tiny

Usually means one of:

- the plugin is not receiving traffic
- the wrong DB path is configured
- the plugin is enabled but not selected

### Broken or truncated summaries detected

Treat this as a signal to inspect summary health before trusting compacted context heavily.

For MVP guidance:

- keep the user on `/lcm doctor`
- explain the count and affected conversations
- avoid advertising separate repair-vs-doctor command families

## Safe operator advice

- Do not guess exact historical details from compacted context alone.
- When a user wants a fact pattern verified, use recall tools to recover evidence.
- Prefer changing one configuration knob at a time and then re-checking `/lcm`.
