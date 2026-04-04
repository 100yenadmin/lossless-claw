/**
 * Per-database async transaction mutex.
 *
 * Hotfix for https://github.com/Martian-Engineering/lossless-claw/issues/260
 *
 * Problem: Multiple async operations (from different sessions) share one
 * synchronous DatabaseSync handle. SQLite does not support nested transactions.
 * When two async code paths both try to BEGIN while an earlier BEGIN is still
 * in-flight (awaiting async work inside the transaction), the second BEGIN
 * fails with "cannot start a transaction within a transaction".
 *
 * Solution: A per-database async mutex that serializes all explicit transaction
 * entry points. Uses a WeakMap keyed on the DatabaseSync instance so each
 * database gets its own queue, and databases are garbage-collected normally.
 */

import type { DatabaseSync } from "node:sqlite";

interface MutexState {
  /** Tail of the promise chain — each acquirer appends to this. */
  tail: Promise<void>;
}

const mutexMap = new WeakMap<DatabaseSync, MutexState>();

function getOrCreateMutex(db: DatabaseSync): MutexState {
  let state = mutexMap.get(db);
  if (!state) {
    state = { tail: Promise.resolve() };
    mutexMap.set(db, state);
  }
  return state;
}

/**
 * Acquire exclusive async access to the database for a transaction.
 *
 * This hotfix mutex is intentionally non-reentrant: reacquiring the same
 * database lock before releasing it will wait forever. Current in-tree
 * patched entry points do not re-enter on the same async path, but callers
 * must avoid nesting transaction entry on the same DatabaseSync handle.
 *
 * Usage:
 *   const release = await acquireTransactionLock(this.db);
 *   try {
 *     this.db.exec("BEGIN IMMEDIATE");
 *     // ... do work ...
 *     this.db.exec("COMMIT");
 *   } catch (err) {
 *     this.db.exec("ROLLBACK");
 *     throw err;
 *   } finally {
 *     release();
 *   }
 *
 * Returns a release function that MUST be called in a finally block.
 */
export function acquireTransactionLock(db: DatabaseSync): Promise<() => void> {
  const mutex = getOrCreateMutex(db);

  let releaseResolve!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  // Capture the current tail — we wait on it
  const waitOn = mutex.tail;

  // Advance the tail — next acquirer will wait on our release
  mutex.tail = releasePromise;

  // Wait for the previous holder to release, then return our release fn
  return waitOn.then(() => releaseResolve);
}
