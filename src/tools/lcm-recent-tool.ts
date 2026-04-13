import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import { formatTimestamp } from "../compaction.js";
import type { LcmContextEngine } from "../engine.js";
import { EpisodeStore } from "../store/episode-store.js";
import { RollupStore } from "../store/rollup-store.js";
import { TrackerStore, type TrackerKind } from "../store/tracker-store.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { parseIsoTimestampParam, resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const LcmRecentSchema = Type.Object({
  period: Type.Optional(
    Type.String({
      description:
        'Time period: "today", "yesterday", "morning", "afternoon", "evening", "7d", "week", "month", "30d", "open_items", "blockers", "episodes", "episode:keyword", "Nh" (up to 72h, e.g. "6h"), or "date:YYYY-MM-DD"',
    }),
  ),
  topic: Type.Optional(
    Type.String({
      description: "Filter results to a specific topic or keyword",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to current session.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description: "Search all conversations.",
    }),
  ),
  includeSources: Type.Optional(
    Type.Boolean({
      description: "Include source summary IDs.",
    }),
  ),
});

type RollupStatus = "building" | "ready" | "stale" | "failed";
type RollupPeriodKind = "day" | "week" | "month";

type RollupRecord = {
  rollupId: string;
  conversationId: number;
  periodKind: RollupPeriodKind;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
  content: string;
  tokenCount: number;
  sourceSummaryIds: string[];
  sourceMessageCount: number;
  sourceTokenCount: number;
  status: RollupStatus;
  coverageStart: Date | null;
  coverageEnd: Date | null;
  summarizerModel: string | null;
  sourceFingerprint: string | null;
  builtAt: Date;
  invalidatedAt: Date | null;
  errorText: string | null;
};

type RecentSummaryFallbackRow = {
  summary_id: string;
  kind: string;
  content: string;
  token_count: number;
  created_at: string;
  effective_time: string;
};

type PeriodResolution = {
  label: string;
  kind?: RollupPeriodKind;
  periodKey?: string;
  trackerKind?: TrackerKind;
  episodeKeyword?: string;
  mode?: "rollup" | "episodes" | "episode";
  start: Date;
  end: Date;
};

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function formatDisplayTime(
  value: Date | string | number | null | undefined,
  timezone: string,
): string {
  if (value == null) {
    return "-";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return formatTimestamp(date, timezone);
}

function getLcmDatabase(lcm: LcmContextEngine): DatabaseSync {
  const candidate = lcm as unknown as { db?: DatabaseSync };
  if (!candidate.db) {
    throw new Error("LCM rollup database is unavailable.");
  }
  return candidate.db;
}

function getPartsInTimezone(date: Date, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return { year, month, day };
}

function getZonedDayString(date: Date, timezone: string): string {
  const { year, month, day } = getPartsInTimezone(date, timezone);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function getUtcDateForZonedMidnight(dayString: string, timezone: string): Date {
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const approxUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(approxUtc);
  const zonedYear = Number(parts.find((part) => part.type === "year")?.value);
  const zonedMonth = Number(parts.find((part) => part.type === "month")?.value);
  const zonedDay = Number(parts.find((part) => part.type === "day")?.value);
  const zonedHour = Number(parts.find((part) => part.type === "hour")?.value);
  const zonedMinute = Number(parts.find((part) => part.type === "minute")?.value);
  const zonedSecond = Number(parts.find((part) => part.type === "second")?.value);
  const asUtc = Date.UTC(zonedYear, zonedMonth - 1, zonedDay, zonedHour, zonedMinute, zonedSecond);
  const desiredUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return new Date(approxUtc.getTime() - (asUtc - desiredUtc));
}

function addDays(dayString: string, delta: number): string {
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day + delta, 0, 0, 0, 0));
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function startOfWeekDayString(dayString: string): string {
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const weekday = date.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(dayString, mondayOffset);
}

function startOfMonthDayString(dayString: string): string {
  const [year, month] = dayString.split("-");
  return `${year}-${month}-01`;
}

function getUtcDateForZonedTime(
  dayString: string,
  timezone: string,
  hour: number,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  const startOfDay = getUtcDateForZonedMidnight(dayString, timezone);
  return new Date(startOfDay.getTime() + ((((hour * 60) + minute) * 60) + second) * 1000 + millisecond);
}

function resolvePeriod(period: string, timezone: string): PeriodResolution {
  const normalized = period.trim().toLowerCase();
  const now = new Date();
  const today = getZonedDayString(now, timezone);

  if (normalized === "episodes") {
    return {
      label: "episodes",
      mode: "episodes",
      start: now,
      end: now,
    };
  }

  if (normalized.startsWith("episode:")) {
    const keyword = period.trim().slice("episode:".length).trim();
    if (!keyword) {
      throw new Error('period "episode:keyword" requires a non-empty keyword.');
    }
    return {
      label: `episode: ${keyword}`,
      mode: "episode",
      episodeKeyword: keyword,
      start: now,
      end: now,
    };
  }

  if (normalized === "today") {
    const start = getUtcDateForZonedMidnight(today, timezone);
    const end = getUtcDateForZonedMidnight(addDays(today, 1), timezone);
    return { label: "today", kind: "day", periodKey: today, start, end };
  }

  if (normalized === "yesterday") {
    const day = addDays(today, -1);
    const start = getUtcDateForZonedMidnight(day, timezone);
    const end = getUtcDateForZonedMidnight(today, timezone);
    return { label: "yesterday", kind: "day", periodKey: day, start, end };
  }

  if (normalized === "morning") {
    return {
      label: "this morning",
      start: getUtcDateForZonedTime(today, timezone, 6),
      end: getUtcDateForZonedTime(today, timezone, 12),
    };
  }

  if (normalized === "afternoon") {
    return {
      label: "this afternoon",
      start: getUtcDateForZonedTime(today, timezone, 12),
      end: getUtcDateForZonedTime(today, timezone, 18),
    };
  }

  if (normalized === "evening") {
    return {
      label: "this evening",
      start: getUtcDateForZonedTime(today, timezone, 18),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  const hoursMatch = normalized.match(/^(\d+)h$/);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    if (!Number.isInteger(hours) || hours < 1) {
      throw new Error('period hours must be a positive integer in the form "Nh".');
    }
    if (hours > 72) {
      throw new Error('period hours must be 72h or less. Use day-based syntax like "7d" for longer ranges.');
    }
    return {
      label: `last ${hours} hour${hours === 1 ? "" : "s"}`,
      start: new Date(now.getTime() - hours * 60 * 60 * 1000),
      end: now,
    };
  }

  if (normalized.startsWith("date:")) {
    const day = normalized.slice(5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error('period date must be in the form "date:YYYY-MM-DD".');
    }
    const start = getUtcDateForZonedMidnight(day, timezone);
    const end = getUtcDateForZonedMidnight(addDays(day, 1), timezone);
    return { label: day, kind: "day", periodKey: day, start, end };
  }

  if (normalized === "7d") {
    const startDay = addDays(today, -6);
    return {
      label: "last 7 days",
      kind: "day",
      start: getUtcDateForZonedMidnight(startDay, timezone),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  if (normalized === "30d") {
    const startDay = addDays(today, -29);
    return {
      label: "last 30 days",
      kind: "day",
      start: getUtcDateForZonedMidnight(startDay, timezone),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  if (normalized === "open_items") {
    const weekStartDay = startOfWeekDayString(today);
    return {
      label: "open items this week",
      trackerKind: "open_item",
      start: getUtcDateForZonedMidnight(weekStartDay, timezone),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  if (normalized === "blockers") {
    const weekStartDay = startOfWeekDayString(today);
    return {
      label: "blockers this week",
      trackerKind: "blocker",
      start: getUtcDateForZonedMidnight(weekStartDay, timezone),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  if (normalized === "week") {
    const weekStartDay = startOfWeekDayString(today);
    const start = getUtcDateForZonedMidnight(weekStartDay, timezone);
    const end = getUtcDateForZonedMidnight(addDays(weekStartDay, 7), timezone);
    return {
      label: `week of ${weekStartDay}`,
      kind: "week",
      periodKey: weekStartDay,
      start,
      end,
    };
  }

  if (normalized === "month") {
    const monthStartDay = startOfMonthDayString(today);
    const [year, month] = monthStartDay.split("-").map((part) => Number(part));
    const nextMonthStartDay = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
    return {
      label: `${monthStartDay.slice(0, 7)}`,
      kind: "month",
      periodKey: monthStartDay.slice(0, 7),
      start: getUtcDateForZonedMidnight(monthStartDay, timezone),
      end: getUtcDateForZonedMidnight(nextMonthStartDay, timezone),
    };
  }

  throw new Error(
    'period must be one of "today", "yesterday", "morning", "afternoon", "evening", "7d", "week", "month", "30d", "open_items", "blockers", "episodes", "episode:keyword", "Nh" (up to 72h), or "date:YYYY-MM-DD".',
  );
}

function formatDayRange(firstDay: string, lastDay: string): string {
  return firstDay === lastDay ? firstDay : `${firstDay} → ${lastDay}`;
}

function formatDaysOpen(sourceDay: string): number {
  const started = new Date(`${sourceDay}T00:00:00.000Z`);
  const diffMs = Date.now() - started.getTime();
  return Math.max(0, Math.floor(diffMs / 86_400_000));
}

function formatSourcesLine(summaryIds: string[], includeSources: boolean): string {
  if (!includeSources || summaryIds.length === 0) {
    return "*Sources: omitted*";
  }
  return `*Sources: ${summaryIds.join(", ")}*`;
}

function combineRollups(rollups: RollupRecord[]): {
  content: string;
  tokenCount: number;
  status: "ready" | "stale";
  sourceSummaryIds: string[];
} {
  const content = rollups
    .map((rollup) => `### ${rollup.periodKey}\n\n${rollup.content.trim()}`)
    .join("\n\n");
  const tokenCount = rollups.reduce((sum, rollup) => sum + rollup.tokenCount, 0);
  const sourceSummaryIds = [...new Set(rollups.flatMap((rollup) => rollup.sourceSummaryIds))];
  const status = rollups.every((rollup) => rollup.status === "ready") ? "ready" : "stale";
  return { content, tokenCount, status, sourceSummaryIds };
}

function filterRollupContentByTopic(content: string, topic: string): string {
  const normalizedTopic = topic.trim().toLowerCase();
  if (!normalizedTopic) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const includeIndexes = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.toLowerCase().includes(normalizedTopic)) {
      includeIndexes.add(index - 1);
      includeIndexes.add(index);
      includeIndexes.add(index + 1);
    }
  }

  const validIndexes = [...includeIndexes]
    .filter((index) => index >= 0 && index < lines.length)
    .sort((a, b) => a - b);

  if (validIndexes.length === 0) {
    return "No matching topic lines found in this rollup.";
  }

  const filtered: string[] = [];
  let previousIndex: number | null = null;
  for (const index of validIndexes) {
    if (previousIndex !== null && index > previousIndex + 1) {
      filtered.push("...");
    }
    filtered.push(lines[index] ?? "");
    previousIndex = index;
  }

  return filtered.join("\n").trim();
}

function getRecentSummaryFallback(
  db: DatabaseSync,
  conversationId: number,
  start: Date,
  end: Date,
  topic?: string,
): RecentSummaryFallbackRow[] {
  const hasTopic = typeof topic === "string" && topic.trim().length > 0;
  return db
    .prepare(
      `SELECT
        summary_id,
        kind,
        content,
        token_count,
        created_at,
        coalesce(latest_at, earliest_at, created_at) AS effective_time
       FROM summaries
       WHERE conversation_id = ?
         AND kind = 'leaf'
         AND coalesce(latest_at, earliest_at, created_at) >= ?
         AND coalesce(latest_at, earliest_at, created_at) < ?
         ${hasTopic ? "AND lower(content) LIKE '%' || ? || '%'" : ""}
       ORDER BY coalesce(latest_at, earliest_at, created_at) DESC
       LIMIT 20`,
    )
    .all(
      ...(hasTopic
        ? [conversationId, start.toISOString(), end.toISOString(), topic!.trim().toLowerCase()]
        : [conversationId, start.toISOString(), end.toISOString()]),
    ) as unknown as RecentSummaryFallbackRow[];
}

export function createLcmRecentTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  rollupStore?: RollupStore;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_recent",
    label: "LCM Recent",
    description:
      "Retrieve recent activity summaries from pre-built temporal rollups. Returns daily, weekly, or monthly summaries without LLM calls. Use for questions like 'what happened today?', 'what did we do yesterday?', or recap requests. Falls back to time-bounded lcm_grep when no rollup exists.",
    parameters: LcmRecentSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }

      const p = params as Record<string, unknown>;
      const includeSources = p.includeSources === true;
      const timezone = lcm.timezone;
      const retrieval = lcm.getRetrieval();
      const topic = typeof p.topic === "string" ? p.topic.trim() : "";
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });

      if (!conversationScope.allConversations && conversationScope.conversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      const requestedPeriod = typeof p.period === "string" && p.period.trim().length > 0 ? p.period.trim() : undefined;

      let resolution: PeriodResolution;
      try {
        resolution = resolvePeriod(requestedPeriod ?? (topic ? "7d" : ""), timezone);
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : "Invalid period.",
        });
      }

      try {
        parseIsoTimestampParam(p, "since");
        parseIsoTimestampParam(p, "before");
      } catch {
        // Intentional no-op, imported helper kept aligned with surrounding tool conventions.
      }

      if (conversationScope.allConversations) {
        const fallback = await retrieval.grep({
          query: topic || "",
          mode: "full_text",
          scope: "both",
          conversationId: undefined,
          since: resolution.start,
          before: resolution.end,
          sort: "recency",
          limit: 20,
        });

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}${topic ? ` (filtered: ${topic})` : ""}`);
        lines.push(
          `**Period:** ${formatDisplayTime(resolution.start, timezone)} — ${formatDisplayTime(resolution.end, timezone)}`,
        );
        lines.push("**Status:** fallback");
        lines.push(`**Token count:** 0`);
        lines.push("");
        if (fallback.totalMatches === 0) {
          lines.push("No pre-built rollup found, and no recent matching activity was found in the fallback search.");
        } else {
          if (fallback.messages.length > 0) {
            lines.push("### Messages");
            lines.push("");
            for (const msg of fallback.messages) {
              lines.push(
                `- [msg#${msg.messageId}] (${msg.role}, ${formatDisplayTime(msg.createdAt, timezone)}): ${msg.snippet.replace(/\n/g, " ").trim()}`,
              );
            }
            lines.push("");
          }
          if (fallback.summaries.length > 0) {
            lines.push("### Summaries");
            lines.push("");
            for (const sum of fallback.summaries) {
              lines.push(
                `- [${sum.summaryId}] (${sum.kind}, ${formatDisplayTime(sum.createdAt, timezone)}): ${sum.snippet.replace(/\n/g, " ").trim()}`,
              );
            }
            lines.push("");
          }
        }
        lines.push("---");
        lines.push(formatSourcesLine(fallback.summaries.map((sum) => sum.summaryId), includeSources));
        lines.push("*Drill down: Use lcm_expand_query with matching summaryIds for deeper recall*");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "fallback",
            usedFallback: true,
            totalMatches: fallback.totalMatches,
          },
        };
      }

      const db = getLcmDatabase(lcm);
      const rollupStore = input.rollupStore ?? new RollupStore(db);
      const trackerStore = new TrackerStore(db);
      const episodeStore = new EpisodeStore(db);
      const conversationId = conversationScope.conversationId as number;

      if (resolution.mode === "episodes") {
        const episodes = episodeStore.getActiveEpisodes(conversationId);
        const lines: string[] = [];
        lines.push("## Active Episodes");
        lines.push(`**Conversation:** ${conversationId}`);
        lines.push(`**Count:** ${episodes.length}`);
        lines.push("");
        if (episodes.length === 0) {
          lines.push("No active or stale episodes found.");
        } else {
          for (const episode of episodes) {
            const keywords = parseJsonStringArray(episode.keywords);
            lines.push(`### ${episode.title}`);
            lines.push(`- Status: ${episode.status}`);
            lines.push(`- Duration: ${episode.day_count} day(s)`);
            lines.push(`- Days: ${formatDayRange(episode.first_day, episode.last_day)}`);
            lines.push(`- Last activity: ${episode.last_day}`);
            lines.push(`- Keywords: ${keywords.length > 0 ? keywords.join(", ") : "None"}`);
            lines.push("");
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "ready",
            episodeCount: episodes.length,
          },
        };
      }

      if (resolution.mode === "episode") {
        const episode = episodeStore.searchEpisodes(conversationId, resolution.episodeKeyword ?? "")[0] ?? null;
        if (!episode) {
          return jsonResult({ error: `No episode matched keyword \"${resolution.episodeKeyword}\".` });
        }

        const rollups = parseJsonStringArray(episode.rollup_ids)
          .map((rollupId) => rollupStore.getRollupById(rollupId))
          .filter((rollup): rollup is NonNullable<typeof rollup> => Boolean(rollup))
          .sort((left, right) => left.period_key.localeCompare(right.period_key));
        const keywords = parseJsonStringArray(episode.keywords);
        const lines: string[] = [];
        lines.push(`## Episode: ${episode.title}`);
        lines.push(`**Status:** ${episode.status}`);
        lines.push(`**Duration:** ${episode.day_count} day(s)`);
        lines.push(`**Days:** ${formatDayRange(episode.first_day, episode.last_day)}`);
        lines.push(`**Keywords:** ${keywords.length > 0 ? keywords.join(", ") : "None"}`);
        lines.push("");
        if (rollups.length === 0) {
          lines.push("No rollups were attached to this episode.");
        } else {
          lines.push("## Day-by-day rollups");
          lines.push("");
          for (const rollup of rollups) {
            lines.push(`### ${rollup.period_key}`);
            lines.push(rollup.content.trim());
            lines.push("");
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "ready",
            episodeId: episode.episode_id,
            rollupCount: rollups.length,
          },
        };
      }

      if (resolution.trackerKind) {
        const startDay = getZonedDayString(resolution.start, timezone);
        const openTrackers = trackerStore
          .getOpenTrackers(conversationId, resolution.trackerKind)
          .filter((tracker) => tracker.source_day >= startDay);

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}`);
        lines.push(
          `**Period:** ${formatDisplayTime(resolution.start, timezone)} — ${formatDisplayTime(resolution.end, timezone)}`,
        );
        lines.push("**Status:** ready");
        lines.push(`**Open items:** ${openTrackers.length}`);
        lines.push("");
        if (openTrackers.length === 0) {
          lines.push("No open tracked items found for this period.");
        } else {
          for (const tracker of openTrackers) {
            lines.push(
              `- [${tracker.kind}] opened ${tracker.source_day} (${formatDaysOpen(tracker.source_day)}d open): ${tracker.content}`,
            );
          }
        }
        lines.push("");
        lines.push("---");
        lines.push("*Sources: tracker state*");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "ready",
            trackerKind: resolution.trackerKind,
            totalOpen: openTrackers.length,
          },
        };
      }

      let rollupContent: string | null = null;
      let tokenCount = 0;
      let status: "ready" | "stale" | "fallback" = "fallback";
      let sourceSummaryIds: string[] = [];

      const shouldUseRollupPath = resolution.kind != null && !/^(morning|afternoon|evening|\d+h)$/i.test(requestedPeriod ?? "");

      if (shouldUseRollupPath && resolution.periodKey) {
        const rollup = rollupStore.getRollup(conversationId, resolution.kind, resolution.periodKey);
        if (rollup && (rollup.status === "ready" || rollup.status === "stale")) {
          rollupContent = topic ? filterRollupContentByTopic(rollup.content, topic) : rollup.content;
          tokenCount = rollup.token_count;
          status = rollup.status === "ready" ? "ready" : "stale";
          sourceSummaryIds = parseJsonStringArray(rollup.source_summary_ids);
        }
      } else if (shouldUseRollupPath && resolution.kind) {
        const rollups = rollupStore.listRollups(conversationId, resolution.kind, 200)
          .filter((rollup) => new Date(rollup.period_start) >= resolution.start && new Date(rollup.period_start) < resolution.end);
        const usableRollups = rollups.filter((rollup) => rollup.status === "ready" || rollup.status === "stale").map((rollup) => ({
          rollupId: rollup.rollup_id,
          conversationId: rollup.conversation_id,
          periodKind: rollup.period_kind,
          periodKey: rollup.period_key,
          periodStart: new Date(rollup.period_start),
          periodEnd: new Date(rollup.period_end),
          timezone: rollup.timezone,
          content: rollup.content,
          tokenCount: rollup.token_count,
          sourceSummaryIds: parseJsonStringArray(rollup.source_summary_ids),
          sourceMessageCount: rollup.source_message_count,
          sourceTokenCount: rollup.source_token_count,
          status: rollup.status,
          coverageStart: rollup.coverage_start ? new Date(rollup.coverage_start) : null,
          coverageEnd: rollup.coverage_end ? new Date(rollup.coverage_end) : null,
          summarizerModel: rollup.summarizer_model,
          sourceFingerprint: rollup.source_fingerprint,
          builtAt: new Date(rollup.built_at),
          invalidatedAt: rollup.invalidated_at ? new Date(rollup.invalidated_at) : null,
          errorText: rollup.error_text,
        }));
        if (usableRollups.length > 0) {
          const combined = combineRollups(usableRollups);
          rollupContent = topic ? filterRollupContentByTopic(combined.content, topic) : combined.content;
          tokenCount = combined.tokenCount;
          status = combined.status;
          sourceSummaryIds = combined.sourceSummaryIds;
        }
      }

      if (rollupContent == null) {
        const recentSummaries = getRecentSummaryFallback(db, conversationId, resolution.start, resolution.end, topic);

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}${topic ? ` (filtered: ${topic})` : ""}`);
        lines.push(
          `**Period:** ${formatDisplayTime(resolution.start, timezone)} — ${formatDisplayTime(resolution.end, timezone)}`,
        );
        lines.push("**Status:** fallback");
        lines.push("**Token count:** 0");
        lines.push("");
        if (recentSummaries.length === 0) {
          lines.push("No pre-built rollup available, and LCM captured no leaf summaries for this period.");
        } else {
          lines.push("No pre-built rollup available. Here's what LCM captured for this period:");
          lines.push("");
          for (const summary of recentSummaries) {
            lines.push(
              `- [${summary.summary_id}] (${summary.kind}, ${formatDisplayTime(summary.effective_time, timezone)}): ${summary.content.replace(/\n/g, " ").trim()}`,
            );
          }
          lines.push("");
          sourceSummaryIds = recentSummaries.map((summary) => summary.summary_id);
        }
        lines.push("---");
        lines.push(formatSourcesLine(sourceSummaryIds, includeSources));
        lines.push("*Drill down: Use lcm_expand_query with these summaryIds for deeper recall*");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "fallback",
            usedFallback: true,
            totalMatches: recentSummaries.length,
            summaryIds: sourceSummaryIds,
          },
        };
      }

      const lines: string[] = [];
      lines.push(
        topic && resolution.kind === "day" && resolution.periodKey
          ? `## Daily rollup for ${resolution.periodKey} (filtered: ${topic})`
          : `## Recent Activity: ${resolution.label}${topic ? ` (filtered: ${topic})` : ""}`,
      );
      lines.push(
        `**Period:** ${formatDisplayTime(resolution.start, timezone)} — ${formatDisplayTime(resolution.end, timezone)}`,
      );
      lines.push(`**Status:** ${status}`);
      lines.push(`**Token count:** ${tokenCount}`);
      lines.push("");
      lines.push(rollupContent.trim());
      lines.push("");
      lines.push("---");
      lines.push(formatSourcesLine(sourceSummaryIds, includeSources));
      lines.push("*Drill down: Use lcm_expand_query with these summaryIds for deeper recall*");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          status,
          usedFallback: false,
          tokenCount,
          summaryIds: sourceSummaryIds,
        },
      };
    },
  };
}
