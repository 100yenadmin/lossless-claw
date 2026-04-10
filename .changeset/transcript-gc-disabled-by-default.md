---
"@martian-engineering/lossless-claw": patch
---

Add an opt-in `transcriptGcEnabled` config flag, defaulting it to `false`, and skip transcript-GC rewrites during `maintain()` unless the flag is enabled. Also add startup diagnostics and documentation for the new setting.
