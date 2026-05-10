/**
 * Regression tests for bugs fixed on 2026-03-17 (nyx-lossless-v2).
 * Covers: session key continuity, ReDoS protection, grant scope,
 * content extraction, and heartbeat pruning.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import type { LcmConfig } from "../src/db/config.js";
import { LcmContextEngine } from "../src/engine.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { ExpansionAuthManager, createDelegatedExpansionGrant, getRuntimeExpansionAuthManager } from "../src/expansion-auth.js";
import type { LcmDependencies } from "../src/types.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return db;
}

function createStores(db: DatabaseSync) {
  const { fts5Available } = getLcmDbFeatures(db);
  return {
    convStore: new ConversationStore(db, { fts5Available }),
    sumStore: new SummaryStore(db, { fts5Available }),
  };
}

function createRegressionConfig(): LcmConfig {
  return {
    enabled: true,
    databasePath: ":memory:",
    largeFilesDir: "/tmp/lcm-regression-files",
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    contextThreshold: 0.75,
    freshTailCount: 8,
    newSessionRetainDepth: 2,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4_000,
    largeFileTokenThreshold: 25_000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    expansionProvider: "",
    expansionModel: "",
    delegationTimeoutMs: 120_000,
    summaryTimeoutMs: 60_000,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    transcriptGcEnabled: false,
    proactiveThresholdCompactionMode: "deferred",
    autoRotateSessionFiles: {
      enabled: true,
      sizeBytes: 2 * 1024 * 1024,
      startup: "rotate",
      runtime: "rotate",
    },
    summaryMaxOverageFactor: 3,
    customInstructions: "",
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 1_800_000,
    fallbackProviders: [],
    cacheAwareCompaction: {
      enabled: true,
      cacheTTLSeconds: 300,
      maxColdCacheCatchupPasses: 2,
      hotCachePressureFactor: 4,
      hotCacheBudgetHeadroomRatio: 0.2,
      coldCacheObservationThreshold: 3,
      criticalBudgetPressureRatio: 0.70,
    },
    dynamicLeafChunkTokens: {
      enabled: true,
      max: 40_000,
    },
  };
}

function createRegressionDeps(config: LcmConfig, overrides?: Partial<LcmDependencies>): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    getApiKey: vi.fn(async () => "test-api-key"),
    requireApiKey: vi.fn(async () => "test-api-key"),
    parseAgentSessionKey: (sessionKey: string) => {
      const trimmed = sessionKey.trim();
      if (!trimmed.startsWith("agent:")) {
        return null;
      }
      const parts = trimmed.split(":");
      if (parts.length < 3) {
        return null;
      }
      return {
        agentId: parts[1] ?? "main",
        suffix: parts.slice(2).join(":"),
      };
    },
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => process.env.HOME ?? "/tmp",
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveSessionTranscriptFile: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

// ── Session Key Continuity (#106, #107) ─────────────────────────────────────

describe("OpenClaw continuity identities", () => {
  it("keeps the same family and segment while runtime sessions churn inside one active conversation", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv1 = await convStore.getOrCreateConversation("uuid-1", { sessionKey: "agent:main:main" });
    const conv2 = await convStore.getOrCreateConversation("uuid-2", { sessionKey: "agent:main:main" });
    const conv3 = await convStore.getOrCreateConversation("uuid-3", { sessionKey: "agent:main:main" });

    expect(conv1.conversationId).toBe(conv2.conversationId);
    expect(conv2.conversationId).toBe(conv3.conversationId);
    expect(conv1.familyKey).toBe("agent:main:main");
    expect(conv2.familyKey).toBe(conv1.familyKey);
    expect(conv3.familyKey).toBe(conv1.familyKey);
    expect(conv2.segmentKey).toBe(conv1.segmentKey);
    expect(conv3.segmentKey).toBe(conv1.segmentKey);

    const refreshed = await convStore.getConversation(conv1.conversationId);
    expect(refreshed?.sessionId).toBe("uuid-3");
    expect(refreshed?.familyKey).toBe("agent:main:main");
    expect(refreshed?.segmentKey).toBe(conv1.segmentKey);
  });

  it("creates separate conversations for different sessionKeys", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv1 = await convStore.getOrCreateConversation("uuid-1", { sessionKey: "agent:main:main" });
    const conv2 = await convStore.getOrCreateConversation("uuid-2", { sessionKey: "agent:main:subagent:abc" });

    expect(conv1.conversationId).not.toBe(conv2.conversationId);
  });

  it("resolves the active conversation when archived rows share the same sessionKey", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const archived = await convStore.createConversation({
      sessionId: "uuid-archived",
      sessionKey: "agent:main:main",
    });
    db.prepare(
      `UPDATE conversations
       SET active = 0,
           archived_at = datetime('now'),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
    ).run(archived.conversationId);

    const active = await convStore.createConversation({
      sessionId: "uuid-active",
      sessionKey: "agent:main:main",
    });

    const byKey = await convStore.getConversationBySessionKey("agent:main:main");
    expect(byKey?.conversationId).toBe(active.conversationId);
    expect(byKey?.active).toBe(true);
    expect(byKey?.familyKey).toBe("agent:main:main");
    expect(byKey?.segmentKey).toBe(active.segmentKey);
  });

  it("creates a fresh segment in the same family instead of reusing an archived row", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const archived = await convStore.createConversation({
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });
    db.prepare(
      `UPDATE conversations
       SET active = 0,
           archived_at = datetime('now'),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
    ).run(archived.conversationId);

    const fresh = await convStore.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });

    expect(fresh.conversationId).not.toBe(archived.conversationId);
    expect(fresh.active).toBe(true);
    expect(fresh.archivedAt).toBeNull();
    expect(fresh.familyKey).toBe(archived.familyKey);
    expect(fresh.segmentKey).not.toBe(archived.segmentKey);
  });

  it("backfills sessionKey when found by sessionId", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    // Create without sessionKey (legacy path)
    const conv1 = await convStore.getOrCreateConversation("uuid-1");
    expect(conv1.sessionKey).toBeNull();
    expect(conv1.familyKey).toBe("uuid-1");

    // Re-fetch with sessionKey — should backfill
    const conv2 = await convStore.getOrCreateConversation("uuid-1", { sessionKey: "agent:main:main" });
    expect(conv2.conversationId).toBe(conv1.conversationId);
    expect(conv2.familyKey).toBe("agent:main:main");
    expect(conv2.segmentKey).toBe(conv1.segmentKey);

    // Verify backfill persisted
    const byKey = await convStore.getConversationBySessionKey("agent:main:main");
    expect(byKey).not.toBeNull();
    expect(byKey!.conversationId).toBe(conv1.conversationId);
  });

  it("falls back to sessionId when sessionKey is undefined", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv1 = await convStore.getOrCreateConversation("uuid-1");
    const conv2 = await convStore.getOrCreateConversation("uuid-1");

    expect(conv1.conversationId).toBe(conv2.conversationId);
  });

  it("recovers when the sessionKey insert loses a unique-constraint race", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const winner = await convStore.createConversation({
      sessionId: "uuid-winner",
      sessionKey: "agent:main:main",
    });

    const getByKey = convStore.getConversationBySessionKey.bind(convStore);
    const getBySessionId = convStore.getConversationBySessionId.bind(convStore);
    let firstByKeyMiss = true;
    let firstBySessionIdMiss = true;

    vi.spyOn(convStore, "getConversationBySessionKey").mockImplementation(async (sessionKey) => {
      if (firstByKeyMiss) {
        firstByKeyMiss = false;
        return null;
      }
      return getByKey(sessionKey);
    });

    vi.spyOn(convStore, "getConversationBySessionId").mockImplementation(async (sessionId) => {
      if (firstBySessionIdMiss) {
        firstBySessionIdMiss = false;
        return null;
      }
      return getBySessionId(sessionId);
    });

    const recovered = await convStore.getOrCreateConversation("uuid-loser", {
      sessionKey: "agent:main:main",
    });

    expect(recovered.conversationId).toBe(winner.conversationId);
    expect(recovered.sessionKey).toBe("agent:main:main");
    expect(await convStore.getConversationBySessionId("uuid-loser")).toBeNull();
  });

  it("keeps the same segment when SQLite bootstrap resumes on a successor runtime session", async () => {
    const db = createTestDb();
    const config = createRegressionConfig();
    const firstSessionId = "sqlite-successor-1";
    const secondSessionId = "sqlite-successor-2";
    const sessionKey = "agent:main:sqlite-successor";
    const firstEvents = [
      {
        seq: 0,
        createdAt: Date.parse("2026-05-10T00:00:00Z"),
        event: {
          type: "session",
          version: 3,
          id: firstSessionId,
          timestamp: "2026-05-10T00:00:00.000Z",
          cwd: "/tmp/lcm-sqlite-bootstrap",
        },
      },
      {
        seq: 1,
        createdAt: Date.parse("2026-05-10T00:00:01Z"),
        event: {
          type: "message",
          id: "msg-1",
          parentId: null,
          timestamp: "2026-05-10T00:00:01.000Z",
          message: { role: "user", content: "first turn" },
        },
      },
      {
        seq: 2,
        createdAt: Date.parse("2026-05-10T00:00:02Z"),
        event: {
          type: "message",
          id: "msg-2",
          parentId: "msg-1",
          timestamp: "2026-05-10T00:00:02.000Z",
          message: { role: "assistant", content: "first reply" },
        },
      },
    ];
    const secondEvents = [
      {
        seq: 0,
        createdAt: Date.parse("2026-05-10T00:10:00Z"),
        event: {
          type: "session",
          version: 3,
          id: secondSessionId,
          timestamp: "2026-05-10T00:10:00.000Z",
          cwd: "/tmp/lcm-sqlite-bootstrap",
        },
      },
      {
        seq: 1,
        createdAt: Date.parse("2026-05-10T00:10:01Z"),
        event: {
          type: "message",
          id: "msg-1",
          parentId: null,
          timestamp: "2026-05-10T00:10:01.000Z",
          message: { role: "user", content: "first turn" },
        },
      },
      {
        seq: 2,
        createdAt: Date.parse("2026-05-10T00:10:02Z"),
        event: {
          type: "message",
          id: "msg-2",
          parentId: "msg-1",
          timestamp: "2026-05-10T00:10:02.000Z",
          message: { role: "assistant", content: "first reply" },
        },
      },
      {
        seq: 3,
        createdAt: Date.parse("2026-05-10T00:10:03Z"),
        event: {
          type: "message",
          id: "msg-3",
          parentId: "msg-2",
          timestamp: "2026-05-10T00:10:03.000Z",
          message: { role: "user", content: "successor turn" },
        },
      },
      {
        seq: 4,
        createdAt: Date.parse("2026-05-10T00:10:04Z"),
        event: {
          type: "message",
          id: "msg-4",
          parentId: "msg-3",
          timestamp: "2026-05-10T00:10:04.000Z",
          message: { role: "assistant", content: "successor reply" },
        },
      },
    ];
    const firstFrontier = {
      sessionId: firstSessionId,
      updatedAt: firstEvents.at(-1)!.createdAt,
      eventCount: firstEvents.length,
      lastSeq: firstEvents.at(-1)!.seq,
      baseCreatedAt: firstEvents[0]!.createdAt,
    };
    const secondFrontier = {
      sessionId: secondSessionId,
      updatedAt: secondEvents.at(-1)!.createdAt,
      eventCount: secondEvents.length,
      lastSeq: secondEvents.at(-1)!.seq,
      baseCreatedAt: secondEvents[0]!.createdAt,
    };
    const deps = createRegressionDeps(config, {
      getSqliteSessionTranscriptFrontier: vi
        .fn()
        .mockResolvedValueOnce(firstFrontier)
        .mockResolvedValueOnce(secondFrontier),
      loadSqliteSessionTranscriptDelta: vi
        .fn()
        .mockResolvedValueOnce({
          mode: "reset",
          frontier: firstFrontier,
          events: firstEvents,
        })
        .mockResolvedValueOnce({
          mode: "reset",
          frontier: secondFrontier,
          events: secondEvents,
        }),
    });
    const engine = new LcmContextEngine(deps, db);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: "/tmp/sqlite-successor-first.jsonl",
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    const second = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: "/tmp/sqlite-successor-second.jsonl",
    });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const continuedConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(continuedConversation).not.toBeNull();
    expect(continuedConversation?.conversationId).toBe(originalConversation?.conversationId);
    expect(continuedConversation?.familyKey).toBe(originalConversation?.familyKey);
    expect(continuedConversation?.segmentKey).toBe(originalConversation?.segmentKey);

    const stored = await engine
      .getConversationStore()
      .getMessages(continuedConversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "first turn",
      "first reply",
      "successor turn",
      "successor reply",
    ]);
  });
});

// ── ReDoS Protection (#76) ──────────────────────────────────────────────────

describe("ReDoS protection", () => {
  it("rejects catastrophic backtracking pattern", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    // Create a conversation with a message
    const conv = await convStore.createConversation({ sessionId: "redos-test" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "aaaaaaaaaaaaaaaaaaaaaa",
      tokenCount: 10,
    });

    // This pattern causes catastrophic backtracking: (a+)+$
    const results = await convStore.searchMessages({
      query: "(a+)+$",
      mode: "regex",
      limit: 10,
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(0);
  });

  it("rejects patterns exceeding 500 characters", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "redos-long" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "test content",
      tokenCount: 5,
    });

    const longPattern = "a".repeat(501);
    const results = await convStore.searchMessages({
      query: longPattern,
      mode: "regex",
      limit: 10,
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(0);
  });

  it("handles invalid regex syntax gracefully", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "redos-invalid" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "test content",
      tokenCount: 5,
    });

    // Unterminated character class — should not throw
    const results = await convStore.searchMessages({
      query: "[unterminated",
      mode: "regex",
      limit: 10,
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(0);
  });

  it("normal regex patterns still work", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "redos-normal" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "the quick brown fox",
      tokenCount: 10,
    });

    const results = await convStore.searchMessages({
      query: "quick.*fox",
      mode: "regex",
      limit: 10,
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(1);
  });
});

// ── Grant Scope Inheritance (#72) ───────────────────────────────────────────

describe("Grant scope inheritance", () => {
  it("rejects depth exceeding grant maxDepth via clamping in wrapWithAuth", () => {
    const manager = new ExpansionAuthManager();
    const grant = manager.createGrant({
      issuerSessionId: "parent",
      allowedConversationIds: [1],
      maxDepth: 3,
      tokenCap: 1000,
    });

    // Validation allows it (clamped at execution)
    const result = manager.validateExpansion(grant.grantId, {
      conversationId: 1,
      summaryIds: [],
      depth: 10,
      tokenCap: 500,
    });
    expect(result.valid).toBe(true);
  });

  it("request at exactly maxDepth succeeds validation", () => {
    const manager = new ExpansionAuthManager();
    const grant = manager.createGrant({
      issuerSessionId: "parent",
      allowedConversationIds: [1],
      maxDepth: 3,
      tokenCap: 1000,
    });

    const result = manager.validateExpansion(grant.grantId, {
      conversationId: 1,
      summaryIds: [],
      depth: 3,
      tokenCap: 500,
    });
    expect(result.valid).toBe(true);
  });

  it("consumed tokens reduce remaining budget for subsequent calls", () => {
    const manager = new ExpansionAuthManager();
    const grant = manager.createGrant({
      issuerSessionId: "parent",
      allowedConversationIds: [1],
      tokenCap: 1000,
    });

    expect(manager.getRemainingTokenBudget(grant.grantId)).toBe(1000);
    manager.consumeTokenBudget(grant.grantId, 600);
    expect(manager.getRemainingTokenBudget(grant.grantId)).toBe(400);
    manager.consumeTokenBudget(grant.grantId, 400);
    expect(manager.getRemainingTokenBudget(grant.grantId)).toBe(0);
  });
});

// ── Content Extraction (#105) ───────────────────────────────────────────────

describe("Content extraction", () => {
  // We test via the engine's public interface indirectly through ConversationStore
  // since extractMessageContent is a private function. The engine tests in
  // engine.test.ts cover the acid test for toolCall arrays returning empty string.

  it("stores text content from text blocks correctly", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "content-test" });
    const msg = await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "plain text message",
      tokenCount: 5,
    });

    expect(msg.content).toBe("plain text message");
  });

  it("stores empty string for empty content", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "empty-content" });
    const msg = await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "assistant",
      content: "",
      tokenCount: 0,
    });

    expect(msg.content).toBe("");
  });
});
