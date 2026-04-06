---
"@martian-engineering/lossless-claw": patch
---

Fix compaction summarizer exhaustion handling so multi-provider non-auth failures log the terminal exhaustion path and fall back to deterministic truncation instead of returning an empty summary.
