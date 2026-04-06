---
"@martian-engineering/lossless-claw": patch
---

Tune SQLite defaults for large lossless-claw databases by increasing the page cache, keeping temporary structures in memory, and using WAL-friendly synchronous settings.

Add missing indexes for `summary_messages(message_id)` and `summaries(conversation_id, depth, kind)` so summary cleanup and depth-filtered queries avoid full table scans on existing databases.
