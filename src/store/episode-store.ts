import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface EpisodeRow {
  episode_id: string;
  conversation_id: number;
  title: string;
  status: "active" | "completed" | "stale";
  first_day: string;
  last_day: string;
  keywords: string;
  rollup_ids: string;
  day_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateEpisodeInput {
  episode_id?: string;
  conversation_id: number;
  title: string;
  status?: EpisodeRow["status"];
  first_day: string;
  last_day: string;
  keywords?: string;
  rollup_ids?: string;
  day_count?: number;
}

export class EpisodeStore {
  constructor(private db: DatabaseSync) {}

  createEpisode(input: CreateEpisodeInput): string {
    const episodeId = input.episode_id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO lcm_episodes (
          episode_id,
          conversation_id,
          title,
          status,
          first_day,
          last_day,
          keywords,
          rollup_ids,
          day_count,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        episodeId,
        input.conversation_id,
        input.title,
        input.status ?? "active",
        input.first_day,
        input.last_day,
        input.keywords ?? "[]",
        input.rollup_ids ?? "[]",
        input.day_count ?? 1,
      );
    return episodeId;
  }

  getEpisodeById(episodeId: string): EpisodeRow | null {
    const row = this.db
      .prepare(
        `SELECT
          episode_id,
          conversation_id,
          title,
          status,
          first_day,
          last_day,
          keywords,
          rollup_ids,
          day_count,
          created_at,
          updated_at
         FROM lcm_episodes
         WHERE episode_id = ?`,
      )
      .get(episodeId) as EpisodeRow | undefined;
    return row ?? null;
  }

  getEpisodeEndingOnDay(conversationId: number, day: string): EpisodeRow | null {
    const row = this.db
      .prepare(
        `SELECT
          episode_id,
          conversation_id,
          title,
          status,
          first_day,
          last_day,
          keywords,
          rollup_ids,
          day_count,
          created_at,
          updated_at
         FROM lcm_episodes
         WHERE conversation_id = ?
           AND last_day = ?
           AND status IN ('active', 'stale')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(conversationId, day) as EpisodeRow | undefined;
    return row ?? null;
  }

  getActiveEpisodes(conversationId: number): EpisodeRow[] {
    return this.db
      .prepare(
        `SELECT
          episode_id,
          conversation_id,
          title,
          status,
          first_day,
          last_day,
          keywords,
          rollup_ids,
          day_count,
          created_at,
          updated_at
         FROM lcm_episodes
         WHERE conversation_id = ?
           AND status IN ('active', 'stale')
         ORDER BY last_day DESC, updated_at DESC`,
      )
      .all(conversationId) as unknown as EpisodeRow[];
  }

  getEpisodesByDateRange(conversationId: number, startDay: string, endDay: string): EpisodeRow[] {
    return this.db
      .prepare(
        `SELECT
          episode_id,
          conversation_id,
          title,
          status,
          first_day,
          last_day,
          keywords,
          rollup_ids,
          day_count,
          created_at,
          updated_at
         FROM lcm_episodes
         WHERE conversation_id = ?
           AND first_day <= ?
           AND last_day >= ?
         ORDER BY first_day ASC, last_day ASC`,
      )
      .all(conversationId, endDay, startDay) as unknown as EpisodeRow[];
  }

  extendEpisode(episodeId: string, newDay: string, newRollupId: string, title?: string, keywords?: string): void {
    const existing = this.getEpisodeById(episodeId);
    if (!existing) {
      throw new Error(`Episode not found: ${episodeId}`);
    }

    const rollupIds = parseJsonStringArray(existing.rollup_ids);
    if (!rollupIds.includes(newRollupId)) {
      rollupIds.push(newRollupId);
    }

    const firstDay = existing.first_day < newDay ? existing.first_day : newDay;
    const lastDay = existing.last_day > newDay ? existing.last_day : newDay;
    const dayCount = diffDayCount(firstDay, lastDay);

    this.db
      .prepare(
        `UPDATE lcm_episodes
         SET last_day = ?,
             first_day = ?,
             rollup_ids = ?,
             day_count = ?,
             title = ?,
             keywords = ?,
             status = 'active',
             updated_at = datetime('now')
         WHERE episode_id = ?`,
      )
      .run(
        lastDay,
        firstDay,
        JSON.stringify(rollupIds),
        dayCount,
        title ?? existing.title,
        keywords ?? existing.keywords,
        episodeId,
      );
  }

  completeEpisode(episodeId: string): void {
    this.updateStatus(episodeId, "completed");
  }

  markStale(episodeId: string): void {
    this.updateStatus(episodeId, "stale");
  }

  searchEpisodes(conversationId: number, keyword: string): EpisodeRow[] {
    const normalized = `%${keyword.trim().toLowerCase()}%`;
    return this.db
      .prepare(
        `SELECT
          episode_id,
          conversation_id,
          title,
          status,
          first_day,
          last_day,
          keywords,
          rollup_ids,
          day_count,
          created_at,
          updated_at
         FROM lcm_episodes
         WHERE conversation_id = ?
           AND (
             lower(title) LIKE ?
             OR lower(keywords) LIKE ?
           )
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END,
           last_day DESC,
           updated_at DESC`,
      )
      .all(conversationId, normalized, normalized) as unknown as EpisodeRow[];
  }

  listEpisodes(conversationId: number): EpisodeRow[] {
    return this.db
      .prepare(
        `SELECT
          episode_id,
          conversation_id,
          title,
          status,
          first_day,
          last_day,
          keywords,
          rollup_ids,
          day_count,
          created_at,
          updated_at
         FROM lcm_episodes
         WHERE conversation_id = ?
         ORDER BY last_day DESC, updated_at DESC`,
      )
      .all(conversationId) as unknown as EpisodeRow[];
  }

  private updateStatus(episodeId: string, status: EpisodeRow["status"]): void {
    this.db
      .prepare(
        `UPDATE lcm_episodes
         SET status = ?,
             updated_at = datetime('now')
         WHERE episode_id = ?`,
      )
      .run(status, episodeId);
  }
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function diffDayCount(firstDay: string, lastDay: string): number {
  const first = new Date(`${firstDay}T00:00:00.000Z`);
  const last = new Date(`${lastDay}T00:00:00.000Z`);
  const diff = Math.round((last.getTime() - first.getTime()) / 86_400_000);
  return Math.max(1, diff + 1);
}
