---
"@martian-engineering/lossless-claw": patch
---

Fix `/lcm rotate` so it waits for the live database connection to become idle, takes a faithful pre-rotate backup on that connection, and then compacts the current session transcript without replacing the active LCM conversation. Rotation now preserves the existing conversation id, summaries, and context items while refreshing bootstrap state so dropped transcript history is not replayed.
