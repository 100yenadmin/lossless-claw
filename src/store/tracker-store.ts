import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type TrackerKind = "blocker" | "open_item" | "decision" | "question";
export type TrackerStatus = "open" | "resolved" | "stale";

export interface TrackerRow {
  tracker_id: string;
  conversation_id: number;
  kind: TrackerKind;
  content: string;
  source_rollup_id: string | null;
  source_day: string;
  status: TrackerStatus;
  resolved_day: string | null;
  resolved_rollup_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTrackerInput {
  tracker_id?: string;
  conversation_id: number;
  kind: TrackerKind;
  content: string;
  source_rollup_id?: string | null;
  source_day: string;
  status?: TrackerStatus;
}

export class TrackerStore {
  constructor(private db: DatabaseSync) {}

  createTracker(input: CreateTrackerInput): string {
    const trackerId = input.tracker_id ?? buildTrackerId(input.kind, input.source_day);
    this.db
      .prepare(
        `INSERT INTO lcm_rollup_trackers (
          tracker_id,
          conversation_id,
          kind,
          content,
          source_rollup_id,
          source_day,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        trackerId,
        input.conversation_id,
        input.kind,
        input.content,
        input.source_rollup_id ?? null,
        input.source_day,
        input.status ?? "open",
      );
    return trackerId;
  }

  getOpenTrackers(conversationId: number, kind?: TrackerKind): TrackerRow[] {
    if (kind) {
      return this.db
        .prepare(
          `SELECT
            tracker_id,
            conversation_id,
            kind,
            content,
            source_rollup_id,
            source_day,
            status,
            resolved_day,
            resolved_rollup_id,
            created_at,
            updated_at
           FROM lcm_rollup_trackers
           WHERE conversation_id = ?
             AND status = 'open'
             AND kind = ?
           ORDER BY source_day ASC, created_at ASC`,
        )
        .all(conversationId, kind) as TrackerRow[];
    }

    return this.db
      .prepare(
        `SELECT
          tracker_id,
          conversation_id,
          kind,
          content,
          source_rollup_id,
          source_day,
          status,
          resolved_day,
          resolved_rollup_id,
          created_at,
          updated_at
         FROM lcm_rollup_trackers
         WHERE conversation_id = ?
           AND status = 'open'
         ORDER BY source_day ASC, created_at ASC`,
      )
      .all(conversationId) as TrackerRow[];
  }

  resolveTracker(trackerId: string, resolvedDay: string, resolvedRollupId: string | null): void {
    this.db
      .prepare(
        `UPDATE lcm_rollup_trackers
         SET status = 'resolved',
             resolved_day = ?,
             resolved_rollup_id = ?,
             updated_at = datetime('now')
         WHERE tracker_id = ?`,
      )
      .run(resolvedDay, resolvedRollupId, trackerId);
  }

  markStale(trackerId: string): void {
    this.db
      .prepare(
        `UPDATE lcm_rollup_trackers
         SET status = 'stale',
             updated_at = datetime('now')
         WHERE tracker_id = ?`,
      )
      .run(trackerId);
  }

  getTrackersForPeriod(conversationId: number, startDay: string, endDay: string): TrackerRow[] {
    return this.db
      .prepare(
        `SELECT
          tracker_id,
          conversation_id,
          kind,
          content,
          source_rollup_id,
          source_day,
          status,
          resolved_day,
          resolved_rollup_id,
          created_at,
          updated_at
         FROM lcm_rollup_trackers
         WHERE conversation_id = ?
           AND (
             (source_day >= ? AND source_day <= ?)
             OR (resolved_day IS NOT NULL AND resolved_day >= ? AND resolved_day <= ?)
           )
         ORDER BY source_day ASC, created_at ASC`,
      )
      .all(conversationId, startDay, endDay, startDay, endDay) as TrackerRow[];
  }
}

function buildTrackerId(kind: TrackerKind, sourceDay: string): string {
  return `tracker_${kind}_${sourceDay}_${randomUUID().slice(0, 8)}`;
}
