import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { createLcmDatabaseConnection, closeLcmConnection } from "../src/db/connection.js";
import { resolveLcmConfig } from "../src/db/config.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmCommand, __testing } from "../src/plugin/lcm-command.js";

function createCommandFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-command-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  const summaryStore = new SummaryStore(db, { fts5Available });
  const config = resolveLcmConfig({}, { dbPath });
  const command = createLcmCommand({ db, config });
  return { tempDir, dbPath, command, conversationStore, summaryStore };
}

function createCommandContext(
  args?: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: args ? `/lossless ${args}` : "/lossless",
    args,
    config: {
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
          },
        },
        slots: {
          contextEngine: "lossless-claw",
        },
      },
    },
    requestConversationBinding: async () => ({ status: "error" as const, message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

describe("lcm command", () => {
  const tempDirs = new Set<string>();
  const dbPaths = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("reports compact global status and help hints", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "status-session",
      title: "Status fixture",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "first source message",
        tokenCount: 10,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "second source message",
        tokenCount: 12,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_leaf",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `leaf summary\n${"[Truncated from 2048 tokens]"}`,
      tokenCount: 50,
      sourceMessageTokenCount: 22,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_parent",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "condensed summary",
      tokenCount: 25,
      sourceMessageTokenCount: 22,
    });
    await fixture.summaryStore.linkSummaryToMessages("sum_leaf", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);
    await fixture.summaryStore.linkSummaryToParents("sum_parent", ["sum_leaf"]);

    const result = await fixture.command.handler(createCommandContext());
    expect(result.text).toContain("🦀 Lossless Claw");
    expect(result.text).toContain("Help: `/lossless help`");
    expect(result.text).toContain("Hidden alias: `/lcm`");
    expect(result.text).toContain("🧩 Plugin");
    expect(result.text).toContain("enabled                  yes");
    expect(result.text).toContain("selected                 yes (slot=lossless-claw)");
    expect(result.text).toContain(`db path                  ${fixture.dbPath}`);
    expect(result.text).toContain("🌐 GLOBAL");
    expect(result.text).toContain("summaries                2 (1 leaf, 1 condensed)");
    expect(result.text).toContain("stored summary tokens    75");
    expect(result.text).toContain("summarized source tokens 22");
    expect(result.text).toContain("warning (1 issue; run `/lossless doctor`)");
    expect(result.text).toContain("📍 CURRENT CONVERSATION");
    expect(result.text).toContain("status                   unavailable");
    expect(result.text).toContain("OpenClaw plugin commands do not expose the active session key or session id here");
  });

  it("resolves current conversation stats when the host provides a session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-key-status-session",
      sessionKey: "agent:main:telegram:direct:4242",
      title: "Current conversation fixture",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "current conversation message one",
        tokenCount: 8,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "current conversation message two",
        tokenCount: 13,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "current_leaf",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `current summary body\n${"[Truncated from 512 tokens]"}`,
      tokenCount: 21,
      sourceMessageTokenCount: 21,
    });
    await fixture.summaryStore.linkSummaryToMessages("current_leaf", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:direct:4242",
      }),
    );

    expect(result.text).toContain("📍 CURRENT CONVERSATION");
    expect(result.text).toContain("status                   resolved via session key");
    expect(result.text).toContain(`conversation id          ${conversation.conversationId}`);
    expect(result.text).toContain("messages                 2");
    expect(result.text).toContain("summaries                1 (1 leaf, 0 condensed)");
    expect(result.text).toContain("stored summary tokens    21");
    expect(result.text).toContain("summarized source tokens 21");
    expect(result.text).toContain("doctor                   1 issue(s) in this conversation");
  });

  it("reports doctor scan counts grouped by conversation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const firstConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-one",
    });
    const secondConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-two",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_old",
      conversationId: firstConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `${"[LCM fallback summary; truncated for context management]"}\nlegacy fallback`,
      tokenCount: 10,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_new",
      conversationId: secondConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `useful summary body\n${"[Truncated from 999 tokens]"}`,
      tokenCount: 11,
    });

    const result = await fixture.command.handler(createCommandContext("doctor"));
    expect(result.text).toContain("🩺 Lossless Claw Doctor");
    expect(result.text).toContain("detected summaries       2");
    expect(result.text).toContain("old-marker summaries     1");
    expect(result.text).toContain("truncated-marker summaries 1");
    expect(result.text).toContain(
      `#${firstConversation.conversationId} · 1 total · 1 old · 0 truncated · 0 fallback`,
    );
    expect(result.text).toContain(
      `#${secondConversation.conversationId} · 1 total · 0 old · 1 truncated · 0 fallback`,
    );
  });

  it("falls back to help text for unsupported subcommands", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = await fixture.command.handler(createCommandContext("rewrite"));
    expect(result.text).toContain("⚠️ Unknown subcommand `rewrite`.");
    expect(result.text).toContain("`/lossless help`");
    expect(result.text).toContain("`/lcm` is still accepted but intentionally hidden from native menus.");
  });
});

describe("lcm command helpers", () => {
  it("treats native alias and empty slot states as selected defaults", () => {
    expect(__testing.resolvePluginSelected({})).toBe(true);
    expect(
      __testing.resolvePluginSelected({
        plugins: {
          slots: {
            contextEngine: "default",
          },
        },
      }),
    ).toBe(true);
    expect(
      __testing.resolvePluginSelected({
        plugins: {
          slots: {
            contextEngine: "legacy",
          },
        },
      }),
    ).toBe(false);
  });
});
