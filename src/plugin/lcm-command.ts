import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import packageJson from "../../package.json" with { type: "json" };
import type { LcmConfig } from "../db/config.js";
import type { OpenClawPluginCommandDefinition, PluginCommandContext } from "openclaw/plugin-sdk";

const FALLBACK_SUMMARY_MARKER = "[LCM fallback summary; truncated for context management]";
const TRUNCATED_SUMMARY_PREFIX = "[Truncated from ";
const TRUNCATED_SUMMARY_WINDOW = 40;
const FALLBACK_SUMMARY_WINDOW = 80;

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

function getDoctorSummaryStats(db: DatabaseSync): DoctorSummaryStats {
  const rows = db
    .prepare(
      `SELECT conversation_id, summary_id, COALESCE(content, '') AS content
       FROM summaries
       WHERE INSTR(COALESCE(content, ''), ?) > 0
          OR INSTR(COALESCE(content, ''), ?) > 0`,
    )
    .all(FALLBACK_SUMMARY_MARKER, TRUNCATED_SUMMARY_PREFIX) as Array<{
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
    ...(error ? [error, ""] : []),
    "Lossless Claw command surface",
    "",
    "- `/lcm` or `/lcm status` shows plugin and database health.",
    "- `/lcm doctor` scans for broken or truncated summaries.",
    "- `/lossless` is an alias for `/lcm` on native command surfaces.",
  ];
  return lines.join("\n");
}

function buildStatusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
}): string {
  const status = getLcmStatusStats(params.db);
  const doctor = getDoctorSummaryStats(params.db);
  const enabled = resolvePluginEnabled(params.ctx.config);
  const selected = resolvePluginSelected(params.ctx.config);
  const slot = resolveContextEngineSlot(params.ctx.config);
  const dbSize = resolveDbSizeLabel(params.config.databasePath);

  const lines = [
    "Lossless Claw",
    "",
    `version: ${packageJson.version}`,
    `enabled: ${formatBoolean(enabled)}`,
    `selected: ${formatBoolean(selected)}${slot ? ` (slot=${slot})` : " (slot=unset)"}`,
    `db path: ${params.config.databasePath}`,
    `db size: ${dbSize}`,
    `conversations: ${formatNumber(status.conversationCount)}`,
    `summaries: ${formatNumber(status.summaryCount)} (${formatNumber(status.leafSummaryCount)} leaf, ${formatNumber(status.condensedSummaryCount)} condensed)`,
    `stored summary tokens: ${formatNumber(status.storedSummaryTokens)}`,
    `summarized source tokens: ${formatNumber(status.summarizedSourceTokens)}`,
    `broken or truncated summaries: ${formatBoolean(doctor.total > 0)}${doctor.total > 0 ? ` (${formatNumber(doctor.total)} detected; run /lcm doctor)` : ""}`,
  ];

  return lines.join("\n");
}

function buildDoctorText(db: DatabaseSync): string {
  const stats = getDoctorSummaryStats(db);
  if (stats.total === 0) {
    return [
      "Lossless Claw doctor",
      "",
      "No broken or truncated summaries detected.",
    ].join("\n");
  }

  const lines = [
    "Lossless Claw doctor",
    "",
    `detected summaries: ${formatNumber(stats.total)}`,
    `old-marker summaries: ${formatNumber(stats.old)}`,
    `truncated-marker summaries: ${formatNumber(stats.truncated)}`,
    `fallback-marker summaries: ${formatNumber(stats.fallback)}`,
    "",
    "affected conversations:",
  ];

  const conversations = [...stats.byConversation.entries()].sort((left, right) => {
    if (right[1].total !== left[1].total) {
      return right[1].total - left[1].total;
    }
    return left[0] - right[0];
  });

  for (const [conversationId, counts] of conversations.slice(0, 10)) {
    lines.push(
      `- ${conversationId}: ${formatNumber(counts.total)} total (${formatNumber(counts.old)} old, ${formatNumber(counts.truncated)} truncated, ${formatNumber(counts.fallback)} fallback)`,
    );
  }

  if (conversations.length > 10) {
    lines.push(`- +${formatNumber(conversations.length - 10)} more conversations`);
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
          return { text: buildStatusText({ ctx, db: params.db, config: params.config }) };
        case "doctor":
          return { text: buildDoctorText(params.db) };
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
  resolveContextEngineSlot,
  resolvePluginEnabled,
  resolvePluginSelected,
};
