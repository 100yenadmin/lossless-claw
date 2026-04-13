import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { TrackerStore } from "../src/store/tracker-store.js";
import { extractTrackersFromRollup } from "../src/tracker-extractor.js";
import { createLcmRecentTool } from "../src/tools/lcm-recent-tool.js";
import type { LcmDependencies } from "../src/types.js";

function makeDeps(): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
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
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(),
    callGateway: vi.fn(async () => ({})),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey: () => null,
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "/tmp/openclaw-agent",
    resolveSessionIdFromSessionKey: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as LcmDependencies;
}

function buildLcm(db: DatabaseSync) {
  return {
    timezone: "UTC",
    db,
    getRetrieval: () => ({ grep: vi.fn(), expand: vi.fn(), describe: vi.fn() }),
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn(async () => ({
        conversationId: 42,
        sessionId: "session-1",
        title: null,
        bootstrappedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
      getConversationBySessionKey: vi.fn(async () => null),
    }),
  };
}

describe("lcm_recent tracker support", () => {
  it("extracts open items and keeps unresolved tracker state across days", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });
    db.prepare(
      `INSERT INTO lcm_rollups (rollup_id, conversation_id, period_kind, period_key, period_start, period_end, timezone, content, token_count, source_summary_ids, source_message_count, source_token_count, status)
       VALUES (?, ?, 'day', ?, ?, ?, 'UTC', ?, 10, '[]', 0, 0, 'ready')`,
    ).run("rollup_day_1", 42, "2026-04-07", "2026-04-07T00:00:00.000Z", "2026-04-08T00:00:00.000Z", "# Daily Summary\n\n## Key Items\n- Completed: None\n- Blockers: API auth token rotation is blocking deploy\n- Open Items: follow up with infra team\n");

    const trackerStore = new TrackerStore(db);
    extractTrackersFromRollup({
      conversationId: 42,
      dateKey: "2026-04-07",
      rollupId: "rollup_day_1",
      rollupContent:
        "# Daily Summary\n\n## Activity Timeline\n- [09:00] Investigated deploy issue\n\n## Key Items\n- Decisions: None\n- Completed: None\n- Blockers: API auth token rotation is blocking deploy\n- Open Items: follow up with infra team",
      trackerStore,
    });

    let open = trackerStore.getOpenTrackers(42);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("open_item");

    extractTrackersFromRollup({
      conversationId: 42,
      dateKey: "2026-04-08",
      rollupId: "rollup_day_2",
      rollupContent:
        "# Daily Summary\n\n## Activity Timeline\n- [10:30] Fixed API auth token rotation and deployed\n\n## Key Items\n- Decisions: None\n- Completed: fixed API auth token rotation for deploy\n- Blockers: None\n- Open Items: follow up with infra team",
      trackerStore,
    });

    open = trackerStore.getOpenTrackers(42);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("open_item");

    const period = trackerStore.getTrackersForPeriod(42, "2026-04-07", "2026-04-08");
    expect(period).toHaveLength(1);
    expect(period[0]?.source_day).toBe("2026-04-07");
  });

  it("returns weekly open blockers via lcm_recent", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });

    const trackerStore = new TrackerStore(db);
    db.prepare(
      `INSERT INTO lcm_rollups (rollup_id, conversation_id, period_kind, period_key, period_start, period_end, timezone, content, token_count, source_summary_ids, source_message_count, source_token_count, status)
       VALUES (?, ?, 'day', ?, ?, ?, 'UTC', ?, 5, '[]', 0, 0, 'ready')`,
    ).run(
      "rollup_day_2026-04-13",
      42,
      "2026-04-13",
      "2026-04-13T00:00:00.000Z",
      "2026-04-14T00:00:00.000Z",
      "# Daily Summary\n\n## Key Items\n- Completed: None\n- Blockers: Waiting on production creds from ops\n- Open Items: None",
    );

    trackerStore.createTracker({
      tracker_id: "tracker_blocker_week",
      conversation_id: 42,
      kind: "blocker",
      content: "Waiting on production creds from ops",
      source_day: "2026-04-13",
      source_rollup_id: "rollup_day_2026-04-13",
    });

    const tool = createLcmRecentTool({
      deps: makeDeps(),
      lcm: buildLcm(db) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-open-blockers", { period: "blockers" });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("Waiting on production creds from ops");
    expect(text).toContain("[blocker] opened 2026-04-13");
    expect((result.details as { totalOpen?: number }).totalOpen).toBe(1);
  });
});
