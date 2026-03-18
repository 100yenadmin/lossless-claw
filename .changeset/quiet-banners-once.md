---
"@martian-engineering/lossless-claw": patch
---

Emit LCM startup and configuration banner logs only once per process so
repeated OpenClaw plugin registration during snapshot loads does not duplicate
the same startup lines.
