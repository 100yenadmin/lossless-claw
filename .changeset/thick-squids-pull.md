---
"@martian-engineering/lossless-claw": patch
---

Fix shared-SQLite transaction coordination during bootstrap and compaction so concurrent sessions do not collide on one database connection, and nested transaction scopes on the same async path stay safe.
