---
"@martian-engineering/lossless-claw": patch
---

Fix the hardened `afterTurn()` replay dedup path so it ingests the intended post-turn batch, and add coverage for restart replay when an auto-compaction summary is present.
