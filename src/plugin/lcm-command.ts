import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import packageJson from "../../package.json" with { type: "json" };
import type { LcmConfig } from "../db/config.js";
import type { OpenClawPluginCommandDefinition, PluginCommandContext } from "openclaw/plugin-sdk";

const FALLBACK_SUMMARY_MARKER = "[LCM fallback summary; truncated for context management]";
const TRUNCATED_SUMMARY_PREFIX = "[Truncated from ";
const TRUNCATED_SUMMARY_WINDOW = 40;
const FALLBACK_SUMMARY_WINDOW = 80;
const VISIBLE_COMMAND = "/lossless";
const HIDDEN_ALIAS = "/lcm";

type DoctorMarkerKind = "old" | "new" | "fallback";

type DoctorSummaryCandidate = {
  conversationId: number;
  summaryId: string;
  markerKind: DoctorMarkerKind;
};

type DoctorConversationCounts = {
  total: number;
  old: number;
  truncated: number;
  fallback: number;
};

type DoctorSummaryStats = {
  candidates: DoctorSummaryCandidate[];
  total: number;
  old: number;
  truncated: number;
  fallback: number;
  byConversation: Map<number, DoctorConversationCounts>;
};

type LcmStatusStats = {
  conversationCount: number;
  summaryCount: number;
  storedSummaryTokens: number;
  summarizedSourceTokens: number;
  leafSummaryCount: number;
  condensedSummaryCount: number;
};

type LcmConversationStatusStats = {
  conversationId: number;
  sessionId: string;
  sessionKey: string | null;
  messageCount: number;
  summaryCount: number;
  storedSummaryTokens: number;
  summarizedSourceTokens: number;
  leafSummaryCount: number;
  condensedSummaryCount: number;
};

type CurrentConversationResolution =
  | {
      kind: "resolved";
      source: "session_key" | "session_key_via_session_id" | "session_id";
      stats: LcmConversationStatusStats;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

type ParsedLcmCommand =
  | { kind: "status" }
  | { kind: "doctor" }
  | { kind: "help"; error?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatCommand(command: string): string {
  return `\`${command}\``;
}

function buildHeaderLines(): string[] {
  return [
    `**🦀 Lossless Claw v${packageJson.version}**`,
    `Help: ${formatCommand(`${VISIBLE_COMMAND} help`)} · Alias: ${formatCommand(HIDDEN_ALIAS)}`,
  ];
}

function buildSection(title: string, lines: string[]): string {
  return [`**${title}**`, ...lines.map((line) => `  ${line}`)].join("\n");
}

function buildStatLine(label: string, value: string): string {
  return `${label}: ${value}`;
}

function buildDoctorBadge(params: { total: number; command: string }): string {
  if (params.total === 0) {
    return "clean";
  }
  const issueLabel = params.total === 1 ? "issue" : "issues";
  return `warning (${formatNumber(params.total)} ${issueLabel}; run ${formatCommand(params.command)})`;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = Math.floor((maxChars - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function splitArgs(rawArgs: string | undefined): string[] {
  return (rawArgs ?? "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseLcmCommand(rawArgs: string | undefined): ParsedLcmCommand {
  const tokens = splitArgs(rawArgs);
  if (tokens.length === 0) {
    return { kind: "status" };
  }

  const [head, ...rest] = tokens;
  switch (head.toLowerCase()) {
    case "status":
      return rest.length === 0
        ? { kind: "status" }
        : { kind: "help", error: "`/lcm status` does not accept extra arguments." };
    case "doctor":
      return rest.length === 0
        ? { kind: "doctor" }
        : { kind: "help", error: "`/lcm doctor` does not accept extra arguments in the MVP." };
    case "help":
      return { kind: "help" };
    default:
      return {
        kind: "help",
        error: `Unknown subcommand \`${head}\`. Supported: status, doctor.`,
      };
  }
}

function detectDoctorMarker(content: string): DoctorMarkerKind | null {
  if (content.startsWith(FALLBACK_SUMMARY_MARKER)) {
    return "old";
  }

  const truncatedIndex = content.indexOf(TRUNCATED_SUMMARY_PREFIX);
  if (truncatedIndex >= 0 && content.length - truncatedIndex < TRUNCATED_SUMMARY_WINDOW) {
    return "new";
  }

  const fallbackIndex = content.indexOf(FALLBACK_SUMMARY_MARKER);
  if (fallbackIndex >= 0 && content.length - fallbackIndex < FALLBACK_SUMMARY_WINDOW) {
    return "fallback";
  }

  return null;
}

function getDoctorSummaryStats(
  db: DatabaseSync,
  conversationId?: number,
): DoctorSummaryStats {
  const statement = conversationId === undefined
    ? db.prepare(
        `SELECT conversation_id, summary_id, COALESCE(content, '') AS content
         FROM summaries
         WHERE INSTR(COALESCE(content, ''), ?) > 0
            OR INSTR(COALESCE(content, ''), ?) > 0`,
      )
    : db.prepare(
        `SELECT conversation_id, summary_id, COALESCE(content, '') AS content
         FROM summaries
         WHERE conversation_id = ?
           AND (
             INSTR(COALESCE(content, ''), ?) > 0
             OR INSTR(COALESCE(content, ''), ?) > 0
           )`,
      );
  const rows = (conversationId === undefined
    ? statement.all(FALLBACK_SUMMARY_MARKER, TRUNCATED_SUMMARY_PREFIX)
    : statement.all(conversationId, FALLBACK_SUMMARY_MARKER, TRUNCATED_SUMMARY_PREFIX)) as Array<{
    conversation_id: number;
    summary_id: string;
    content: string;
  }>;

  const candidates: DoctorSummaryCandidate[] = [];
  const byConversation = new Map<number, DoctorConversationCounts>();
  let old = 0;
  let truncated = 0;
  let fallback = 0;

  for (const row of rows) {
    const markerKind = detectDoctorMarker(row.content);
    if (!markerKind) {
      continue;
    }

    const current = byConversation.get(row.conversation_id) ?? {
      total: 0,
      old: 0,
      truncated: 0,
      fallback: 0,
    };
    current.total += 1;

    switch (markerKind) {
      case "old":
        old += 1;
        current.old += 1;
        break;
      case "new":
        truncated += 1;
        current.truncated += 1;
        break;
      case "fallback":
        fallback += 1;
        current.fallback += 1;
        break;
    }

    byConversation.set(row.conversation_id, current);
    candidates.push({
      conversationId: row.conversation_id,
      summaryId: row.summary_id,
      markerKind,
    });
  }

  return {
    candidates,
    total: candidates.length,
    old,
    truncated,
    fallback,
    byConversation,
  };
}

function getLcmStatusStats(db: DatabaseSync): LcmStatusStats {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT COUNT(*) FROM conversations), 0) AS conversation_count,
         COALESCE(COUNT(*), 0) AS summary_count,
         COALESCE(SUM(token_count), 0) AS stored_summary_tokens,
         COALESCE(SUM(CASE WHEN kind = 'leaf' THEN source_message_token_count ELSE 0 END), 0) AS summarized_source_tokens,
         COALESCE(SUM(CASE WHEN kind = 'leaf' THEN 1 ELSE 0 END), 0) AS leaf_summary_count,
         COALESCE(SUM(CASE WHEN kind = 'condensed' THEN 1 ELSE 0 END), 0) AS condensed_summary_count
       FROM summaries`,
    )
    .get() as
    | {
        conversation_count: number;
        summary_count: number;
        stored_summary_tokens: number;
        summarized_source_tokens: number;
        leaf_summary_count: number;
        condensed_summary_count: number;
      }
    | undefined;

  return {
    conversationCount: row?.conversation_count ?? 0,
    summaryCount: row?.summary_count ?? 0,
    storedSummaryTokens: row?.stored_summary_tokens ?? 0,
    summarizedSourceTokens: row?.summarized_source_tokens ?? 0,
    leafSummaryCount: row?.leaf_summary_count ?? 0,
    condensedSummaryCount: row?.condensed_summary_count ?? 0,
  };
}

function getConversationStatusStats(
  db: DatabaseSync,
  conversationId: number,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(
      `SELECT
         c.conversation_id,
         c.session_id,
         c.session_key,
         COALESCE((SELECT COUNT(*) FROM messages WHERE conversation_id = c.conversation_id), 0) AS message_count,
         COALESCE((SELECT COUNT(*) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS summary_count,
         COALESCE((SELECT SUM(token_count) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS stored_summary_tokens,
         COALESCE((SELECT SUM(CASE WHEN kind = 'leaf' THEN source_message_token_count ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS summarized_source_tokens,
         COALESCE((SELECT SUM(CASE WHEN kind = 'leaf' THEN 1 ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS leaf_summary_count,
         COALESCE((SELECT SUM(CASE WHEN kind = 'condensed' THEN 1 ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS condensed_summary_count
       FROM conversations c
       WHERE c.conversation_id = ?`,
    )
    .get(conversationId) as
    | {
        conversation_id: number;
        session_id: string;
        session_key: string | null;
        message_count: number;
        summary_count: number;
        stored_summary_tokens: number;
        summarized_source_tokens: number;
        leaf_summary_count: number;
        condensed_summary_count: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    messageCount: row.message_count,
    summaryCount: row.summary_count,
    storedSummaryTokens: row.stored_summary_tokens,
    summarizedSourceTokens: row.summarized_source_tokens,
    leafSummaryCount: row.leaf_summary_count,
    condensedSummaryCount: row.condensed_summary_count,
  };
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function getConversationStatusBySessionKey(
  db: DatabaseSync,
  sessionKey: string,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(`SELECT conversation_id FROM conversations WHERE session_key = ? LIMIT 1`)
    .get(sessionKey) as { conversation_id: number } | undefined;

  if (!row) {
    return null;
  }

  return getConversationStatusStats(db, row.conversation_id);
}

function getConversationStatusBySessionId(
  db: DatabaseSync,
  sessionId: string,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(
      `SELECT conversation_id
       FROM conversations
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as { conversation_id: number } | undefined;

  if (!row) {
    return null;
  }

  return getConversationStatusStats(db, row.conversation_id);
}

async function resolveCurrentConversation(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
}): Promise<CurrentConversationResolution> {
  const sessionKey = normalizeIdentity(params.ctx.sessionKey);
  const sessionId = normalizeIdentity(params.ctx.sessionId);

  if (sessionKey) {
    const bySessionKey = getConversationStatusBySessionKey(params.db, sessionKey);
    if (bySessionKey) {
      return { kind: "resolved", source: "session_key", stats: bySessionKey };
    }

    if (sessionId) {
      const bySessionId = getConversationStatusBySessionId(params.db, sessionId);
      if (bySessionId) {
        if (!bySessionId.sessionKey || bySessionId.sessionKey === sessionKey) {
          return {
            kind: "resolved",
            source: "session_key_via_session_id",
            stats: bySessionId,
          };
        }

        return {
          kind: "unavailable",
          reason: `Active session key ${formatCommand(sessionKey)} is not stored in LCM yet. Session id fallback found conversation #${formatNumber(bySessionId.conversationId)}, but it is bound to ${formatCommand(bySessionId.sessionKey)}, so Global stats are safer.`,
        };
      }
    }

    return {
      kind: "unavailable",
      reason: sessionId
        ? `No LCM conversation is stored yet for active session key ${formatCommand(sessionKey)} or active session id ${formatCommand(sessionId)}.`
        : `No LCM conversation is stored yet for active session key ${formatCommand(sessionKey)}.`,
    };
  }

  if (sessionId) {
    const bySessionId = getConversationStatusBySessionId(params.db, sessionId);
    if (bySessionId) {
      return { kind: "resolved", source: "session_id", stats: bySessionId };
    }

    return {
      kind: "unavailable",
      reason: `OpenClaw did not expose an active session key here. Tried active session id ${formatCommand(sessionId)}, but no stored LCM conversation matched it.`,
    };
  }

  return {
    kind: "unavailable",
    reason: "OpenClaw did not expose an active session key or session id here, so only GLOBAL stats are available.",
  };
}

function resolvePluginEnabled(config: unknown): boolean {
  const root = asRecord(config);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const entry = asRecord(entries?.["lossless-claw"]);
  if (typeof entry?.enabled === "boolean") {
    return entry.enabled;
  }
  return true;
}

function resolveContextEngineSlot(config: unknown): string {
  const root = asRecord(config);
  const plugins = asRecord(root?.plugins);
  const slots = asRecord(plugins?.slots);
  return typeof slots?.contextEngine === "string" ? slots.contextEngine.trim() : "";
}

function resolvePluginSelected(config: unknown): boolean {
  const slot = resolveContextEngineSlot(config);
  return slot === "" || slot === "lossless-claw" || slot === "default";
}

function resolveDbSizeLabel(dbPath: string): string {
  const trimmed = dbPath.trim();
  if (!trimmed || trimmed === ":memory:" || trimmed.startsWith("file::memory:")) {
    return "in-memory";
  }
  try {
    return formatBytes(statSync(trimmed).size);
  } catch {
    return "missing";
  }
}

function buildHelpText(error?: string): string {
  const lines = [
    ...(error ? [`⚠️ ${error}`, ""] : []),
    ...buildHeaderLines(),
    "",
    buildSection("📘 Commands", [
      buildStatLine(formatCommand(VISIBLE_COMMAND), "Show compact status output."),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} status`), "Show plugin, Global, and current-conversation status."),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} doctor`), "Scan for broken or truncated summaries."),
    ]),
    "",
    buildSection("🧭 Notes", [
      buildStatLine("subcommands", `Discover them with ${formatCommand(`${VISIBLE_COMMAND} help`)}.`),
      buildStatLine("alias", `${formatCommand(HIDDEN_ALIAS)} is accepted as a shorter alias.`),
      buildStatLine("current conversation", "Uses the active LCM session when the host exposes session identity."),
    ]),
  ];
  return lines.join("\n");
}

async function buildStatusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
}): Promise<string> {
  const status = getLcmStatusStats(params.db);
  const doctor = getDoctorSummaryStats(params.db);
  const enabled = resolvePluginEnabled(params.ctx.config);
  const selected = resolvePluginSelected(params.ctx.config);
  const slot = resolveContextEngineSlot(params.ctx.config);
  const dbSize = resolveDbSizeLabel(params.config.databasePath);
  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });

  const lines = [
    ...buildHeaderLines(),
    "",
    buildSection("🧩 Plugin", [
      buildStatLine("enabled", formatBoolean(enabled)),
      buildStatLine("selected", `${formatBoolean(selected)}${slot ? ` (slot=${slot})` : " (slot=unset)"}`),
      buildStatLine("db path", params.config.databasePath),
      buildStatLine("db size", dbSize),
    ]),
    "",
    buildSection("🌐 Global", [
      buildStatLine("conversations", formatNumber(status.conversationCount)),
      buildStatLine(
        "summaries",
        `${formatNumber(status.summaryCount)} (${formatNumber(status.leafSummaryCount)} leaf, ${formatNumber(status.condensedSummaryCount)} condensed)`,
      ),
      buildStatLine("stored summary tokens", formatNumber(status.storedSummaryTokens)),
      buildStatLine("summarized source tokens", formatNumber(status.summarizedSourceTokens)),
      buildStatLine(
        "doctor",
        buildDoctorBadge({ total: doctor.total, command: `${VISIBLE_COMMAND} doctor` }),
      ),
    ]),
    "",
  ];

  if (current.kind === "resolved") {
    const conversationDoctor =
      doctor.byConversation.get(current.stats.conversationId) ?? {
        total: 0,
        old: 0,
        truncated: 0,
        fallback: 0,
      };
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine(
          "session key",
          current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
        ),
        buildStatLine("messages", formatNumber(current.stats.messageCount)),
        buildStatLine(
          "summaries",
          `${formatNumber(current.stats.summaryCount)} (${formatNumber(current.stats.leafSummaryCount)} leaf, ${formatNumber(current.stats.condensedSummaryCount)} condensed)`,
        ),
        buildStatLine("stored summary tokens", formatNumber(current.stats.storedSummaryTokens)),
        buildStatLine("summarized source tokens", formatNumber(current.stats.summarizedSourceTokens)),
        buildStatLine(
          "doctor",
          conversationDoctor.total > 0
            ? `${formatNumber(conversationDoctor.total)} issue(s) in this conversation`
            : "clean",
        ),
      ]),
    );
  } else {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Showing Global stats only."),
      ]),
    );
  }

  return lines.join("\n");
}

async function buildDoctorText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
}): Promise<string> {
  const current = await resolveCurrentConversation(params);

  if (current.kind === "unavailable") {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor",
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Doctor is conversation-scoped, so no global scan ran."),
      ]),
    ].join("\n");
  }

  const stats = getDoctorSummaryStats(params.db, current.stats.conversationId);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor",
    "",
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine(
        "session key",
        current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
      ),
      buildStatLine("scope", "this conversation only"),
    ]),
    "",
    buildSection("🧪 Scan", [
      buildStatLine("detected summaries", formatNumber(stats.total)),
      buildStatLine("old-marker summaries", formatNumber(stats.old)),
      buildStatLine("truncated-marker summaries", formatNumber(stats.truncated)),
      buildStatLine("fallback-marker summaries", formatNumber(stats.fallback)),
      buildStatLine("result", stats.total === 0 ? "clean" : "issues found"),
    ]),
  ];

  if (stats.total > 0) {
    const summaryList = stats.candidates
      .slice()
      .sort((left, right) => left.summaryId.localeCompare(right.summaryId))
      .map((candidate) => `${candidate.summaryId} (${candidate.markerKind})`)
      .join(", ");
    lines.push(
      "",
      buildSection("🧷 Affected summaries", [summaryList]),
    );
  }

  return lines.join("\n");
}

export function createLcmCommand(params: {
  db: DatabaseSync;
  config: LcmConfig;
}): OpenClawPluginCommandDefinition {
  return {
    name: "lcm",
    nativeNames: {
      default: "lossless",
    },
    description: "Show Lossless Claw health and scan for broken summaries.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseLcmCommand(ctx.args);
      switch (parsed.kind) {
        case "status":
          return { text: await buildStatusText({ ctx, db: params.db, config: params.config }) };
        case "doctor":
          return { text: await buildDoctorText({ ctx, db: params.db }) };
        case "help":
          return { text: buildHelpText(parsed.error) };
      }
    },
  };
}

export const __testing = {
  parseLcmCommand,
  detectDoctorMarker,
  getDoctorSummaryStats,
  getLcmStatusStats,
  getConversationStatusStats,
  resolveCurrentConversation,
  resolveContextEngineSlot,
  resolvePluginEnabled,
  resolvePluginSelected,
};
