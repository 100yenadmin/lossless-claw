/**
 * Process-global singleton state for LCM plugin initialization.
 *
 * OpenClaw v2026.4.5+ calls plugin register() per-agent-context (main,
 * subagents, cron lanes). Without sharing, each call opens a new DB
 * connection and runs migrations — causing lock storms on large databases.
 *
 * Uses the same globalThis + Symbol.for() pattern as startup-banner-log.ts
 * to ensure one DB connection and engine per database path per process.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LcmContextEngine } from "../engine.js";

export type SharedLcmInit = {
  database: DatabaseSync | null;
  lcm: LcmContextEngine | null;
  initPromise: Promise<LcmContextEngine> | null;
  initError: Error | null;
  stopped: boolean;
  waitForEngine: () => Promise<LcmContextEngine>;
  waitForDatabase: () => Promise<DatabaseSync>;
};

const SHARED_KEY = Symbol.for(
  "@martian-engineering/lossless-claw/shared-init",
);

function getStore(): Map<string, SharedLcmInit> {
  const g = globalThis as typeof globalThis & {
    [key: symbol]: Map<string, SharedLcmInit> | undefined;
  };
  if (!g[SHARED_KEY]) {
    g[SHARED_KEY] = new Map();
  }
  return g[SHARED_KEY]!;
}

export function getSharedInit(dbPath: string): SharedLcmInit | undefined {
  return getStore().get(dbPath);
}

export function setSharedInit(dbPath: string, init: SharedLcmInit): void {
  getStore().set(dbPath, init);
}

export function removeSharedInit(dbPath: string): void {
  getStore().delete(dbPath);
}

/** Clear all shared init state. Intended for tests only. */
export function clearAllSharedInit(): void {
  getStore().clear();
}
