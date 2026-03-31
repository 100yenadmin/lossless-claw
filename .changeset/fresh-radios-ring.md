---
"@martian-engineering/lossless-claw": patch
---

Block overlapping `lcm_expand_query` delegations from the same origin session so concurrent expansion requests fail fast instead of deadlocking on the shared sub-agent lane.
