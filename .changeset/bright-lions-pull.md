---
"@martian-engineering/lossless-claw": patch
---

Reduce compaction database work by caching per-phase context reads, skipping redundant ordinal resequencing, and tracking token-count deltas instead of re-querying after each pass.
