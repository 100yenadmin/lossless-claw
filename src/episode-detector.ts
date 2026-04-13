import { randomUUID } from "node:crypto";
import type { RollupRow, RollupStore } from "./store/rollup-store.js";
import { EpisodeStore } from "./store/episode-store.js";

const OVERLAP_THRESHOLD = 0.3;
const STALE_DAY_THRESHOLD = 3;
const MAX_KEYWORDS = 20;
const TITLE_KEYWORDS = 5;

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "have", "were", "been", "they", "them", "their",
  "there", "about", "into", "after", "before", "under", "over", "also", "just", "than", "then", "when",
  "what", "where", "which", "while", "would", "could", "should", "shall", "will", "your", "ours", "ourselves",
  "ours", "mine", "yours", "hers", "his", "its", "our", "you", "are", "was", "is", "am", "be", "being",
  "been", "had", "has", "have", "did", "does", "doing", "done", "can", "cannot", "cant", "not", "too",
  "very", "much", "more", "most", "less", "least", "some", "many", "each", "every", "any", "all", "few",
  "use", "used", "using", "via", "per", "day", "week", "month", "today", "yesterday", "tomorrow", "here",
  "note", "notes", "summary", "activity", "timeline", "statistics", "leaf", "summaries", "total", "source",
  "token", "tokens", "time", "span", "open", "items", "item", "completed", "blockers", "decisions", "none",
  "work", "working", "worked", "start", "started", "continue", "continued", "update", "updated", "updates",
  "need", "needs", "still", "later", "make", "made", "making", "look", "looked", "show", "showed", "shows",
  "get", "got", "getting", "set", "setting", "new", "old", "same", "other", "another", "next", "last", "first",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "etc", "http", "https",
  "www", "com", "org", "net", "api", "utc", "gmt", "our", "we", "us", "i", "me", "my", "it", "as",
  "at", "by", "if", "in", "of", "on", "or", "to", "up", "an", "a"
]);

export interface EpisodeDetectionResult {
  created: number;
  extended: number;
  completed: number;
  stale: number;
}

export class EpisodeDetector {
  constructor(
    private readonly rollupStore: RollupStore,
    private readonly episodeStore: EpisodeStore,
  ) {}

  syncConversationEpisodes(conversationId: number, now: Date = new Date()): EpisodeDetectionResult {
    const result: EpisodeDetectionResult = { created: 0, extended: 0, completed: 0, stale: 0 };
    const dailyRollups = this.rollupStore
      .listRollups(conversationId, "day", 365)
      .filter((rollup) => rollup.status === "ready" || rollup.status === "stale")
      .sort((left, right) => left.period_key.localeCompare(right.period_key));

    if (dailyRollups.length === 0) {
      return result;
    }

    const keywordCache = new Map<string, string[]>();

    for (let index = 0; index < dailyRollups.length - 1; index += 1) {
      const current = dailyRollups[index];
      const next = dailyRollups[index + 1];
      if (!areConsecutiveDays(current.period_key, next.period_key)) {
        const endingEpisode = this.episodeStore.getEpisodeEndingOnDay(conversationId, current.period_key);
        if (endingEpisode && endingEpisode.status === "active") {
          this.episodeStore.completeEpisode(endingEpisode.episode_id);
          result.completed += 1;
        }
        continue;
      }

      const currentKeywords = getCachedKeywords(keywordCache, current);
      const nextKeywords = getCachedKeywords(keywordCache, next);
      const overlap = calculateKeywordOverlap(currentKeywords, nextKeywords);

      if (overlap > OVERLAP_THRESHOLD) {
        const priorEpisode = this.episodeStore.getEpisodeEndingOnDay(conversationId, current.period_key);
        const episodeKeywords = mergeKeywords(currentKeywords, nextKeywords);
        const title = buildEpisodeTitle(episodeKeywords);
        if (priorEpisode) {
          const existingRollupIds = parseJsonStringArray(priorEpisode.rollup_ids);
          if (!existingRollupIds.includes(next.rollup_id) || priorEpisode.last_day !== next.period_key) {
            this.episodeStore.extendEpisode(
              priorEpisode.episode_id,
              next.period_key,
              next.rollup_id,
              title,
              JSON.stringify(episodeKeywords),
            );
            result.extended += 1;
          }
        } else {
          this.episodeStore.createEpisode({
            episode_id: `episode_${conversationId}_${current.period_key}_${randomUUID().slice(0, 8)}`,
            conversation_id: conversationId,
            title,
            status: "active",
            first_day: current.period_key,
            last_day: next.period_key,
            keywords: JSON.stringify(episodeKeywords),
            rollup_ids: JSON.stringify([current.rollup_id, next.rollup_id]),
            day_count: dayCountBetween(current.period_key, next.period_key),
          });
          result.created += 1;
        }
      } else {
        const endingEpisode = this.episodeStore.getEpisodeEndingOnDay(conversationId, current.period_key);
        if (endingEpisode && endingEpisode.status === "active") {
          this.episodeStore.completeEpisode(endingEpisode.episode_id);
          result.completed += 1;
        }
      }
    }

    for (const episode of this.episodeStore.getActiveEpisodes(conversationId)) {
      if (episode.status !== "active") {
        continue;
      }
      const age = dayGap(episode.last_day, toDayKey(now));
      if (age >= STALE_DAY_THRESHOLD) {
        this.episodeStore.markStale(episode.episode_id);
        result.stale += 1;
      }
    }

    return result;
  }
}

export function extractSignificantKeywords(content: string): string[] {
  const rawTokens = content.match(/#[0-9]+|[A-Za-z0-9_./-]+/g) ?? [];
  const frequencies = new Map<string, { count: number; original: string; keep: boolean }>();

  for (const token of rawTokens) {
    const cleaned = token.trim();
    if (!cleaned) {
      continue;
    }
    const normalized = cleaned.toLowerCase();
    const isIssue = /^#\d+$/.test(cleaned);
    const isPath = /[/.]/.test(cleaned) && cleaned.length >= 3;
    const isProperNoun = /^[A-Z][A-Za-z0-9_-]+$/.test(cleaned);
    const isRepeatedCandidate = /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(cleaned);

    if (!isIssue && !isPath && normalized.length < 3) {
      continue;
    }
    if (!isIssue && !isPath && STOP_WORDS.has(normalized)) {
      continue;
    }

    const entry = frequencies.get(normalized) ?? {
      count: 0,
      original: cleaned,
      keep: isIssue || isPath || isProperNoun,
    };
    entry.count += 1;
    entry.keep = entry.keep || isIssue || isPath || isProperNoun || (isRepeatedCandidate && entry.count >= 2);
    if (isProperNoun || isPath || isIssue) {
      entry.original = cleaned;
    }
    frequencies.set(normalized, entry);
  }

  return [...frequencies.entries()]
    .filter(([, entry]) => entry.keep || entry.count >= 2)
    .sort((left, right) => {
      if (right[1].count !== left[1].count) {
        return right[1].count - left[1].count;
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, MAX_KEYWORDS)
    .map(([, entry]) => entry.original);
}

function getCachedKeywords(cache: Map<string, string[]>, rollup: RollupRow): string[] {
  const cached = cache.get(rollup.rollup_id);
  if (cached) {
    return cached;
  }
  const extracted = extractSignificantKeywords(rollup.content);
  cache.set(rollup.rollup_id, extracted);
  return extracted;
}

function calculateKeywordOverlap(keywordsA: string[], keywordsB: string[]): number {
  if (keywordsA.length === 0 || keywordsB.length === 0) {
    return 0;
  }
  const left = new Set(keywordsA.map((keyword) => keyword.toLowerCase()));
  const right = new Set(keywordsB.map((keyword) => keyword.toLowerCase()));
  let shared = 0;
  for (const keyword of left) {
    if (right.has(keyword)) {
      shared += 1;
    }
  }
  return shared / Math.min(left.size, right.size);
}

function mergeKeywords(...sets: string[][]): string[] {
  const counts = new Map<string, { count: number; original: string }>();
  for (const keywords of sets) {
    for (const keyword of keywords) {
      const normalized = keyword.toLowerCase();
      const entry = counts.get(normalized) ?? { count: 0, original: keyword };
      entry.count += 1;
      counts.set(normalized, entry);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1].count !== left[1].count) {
        return right[1].count - left[1].count;
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, MAX_KEYWORDS)
    .map(([, entry]) => entry.original);
}

function buildEpisodeTitle(keywords: string[]): string {
  if (keywords.length === 0) {
    return "Untitled episode";
  }
  return keywords.slice(0, TITLE_KEYWORDS).join(", ");
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function areConsecutiveDays(left: string, right: string): boolean {
  return shiftDay(left, 1) === right;
}

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function dayGap(fromDay: string, toDay: string): number {
  const from = new Date(`${fromDay}T00:00:00.000Z`);
  const to = new Date(`${toDay}T00:00:00.000Z`);
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function dayCountBetween(firstDay: string, lastDay: string): number {
  return Math.max(1, dayGap(firstDay, lastDay) + 1);
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
