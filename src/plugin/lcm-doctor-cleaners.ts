import type { DatabaseSync } from "node:sqlite";

export type DoctorCleanerId =
  | "archived_subagents"
  | "cron_sessions"
  | "null_subagent_context";

export type DoctorCleanerExample = {
  conversationId: number;
  sessionKey: string | null;
  messageCount: number;
  firstMessagePreview: string | null;
};

export type DoctorCleanerFilterStat = {
  id: DoctorCleanerId;
  label: string;
  description: string;
  conversationCount: number;
  messageCount: number;
  examples: DoctorCleanerExample[];
};

export type DoctorCleanerScan = {
  filters: DoctorCleanerFilterStat[];
  totalDistinctConversations: number;
  totalDistinctMessages: number;
};

type CleanerDefinition = {
  id: DoctorCleanerId;
  label: string;
  description: string;
  predicateSql: string;
};

type CleanerCountRow = {
  conversation_count: number | null;
  message_count: number | null;
};

type CleanerExampleRow = {
  conversation_id: number;
  session_key: string | null;
  message_count: number | null;
  first_message_preview: string | null;
};

const CLEANER_DEFINITIONS: CleanerDefinition[] = [
  {
    id: "archived_subagents",
    label: "Archived subagents",
    description: "Archived subagent conversations keyed as agent:main:subagent:*.",
    predicateSql: "(c.active = 0 AND c.session_key LIKE 'agent:main:subagent:%')",
  },
  {
    id: "cron_sessions",
    label: "Cron sessions",
    description: "Background cron conversations keyed as agent:main:cron:*.",
    predicateSql: "(c.session_key LIKE 'agent:main:cron:%')",
  },
  {
    id: "null_subagent_context",
    label: "NULL-key subagent context",
    description:
      "Conversations with NULL session_key whose first stored message begins with [Subagent Context].",
    predicateSql: `(
      c.session_key IS NULL
      AND EXISTS (
        SELECT 1
        FROM messages first_message
        WHERE first_message.conversation_id = c.conversation_id
          AND first_message.seq = (
            SELECT MIN(seed.seq)
            FROM messages seed
            WHERE seed.conversation_id = c.conversation_id
          )
          AND first_message.content LIKE '%[Subagent Context]%'
      )
    )`,
  },
];

function getCleanerDefinitions(filterIds?: DoctorCleanerId[]): CleanerDefinition[] {
  if (!filterIds || filterIds.length === 0) {
    return CLEANER_DEFINITIONS;
  }
  const requested = new Set(filterIds);
  return CLEANER_DEFINITIONS.filter((definition) => requested.has(definition.id));
}

function truncatePreview(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function buildDistinctUnionSql(definitions: CleanerDefinition[]): string {
  if (definitions.length === 0) {
    return `SELECT NULL AS conversation_id WHERE 0`;
  }
  return definitions
    .map(
      (definition) =>
        `SELECT c.conversation_id
         FROM conversations c
         WHERE ${definition.predicateSql}`,
    )
    .join(`\nUNION\n`);
}

function scanSingleCleaner(
  db: DatabaseSync,
  definition: CleanerDefinition,
): DoctorCleanerFilterStat {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS conversation_count,
         COALESCE((
           SELECT COUNT(*)
           FROM messages m
           WHERE m.conversation_id IN (
             SELECT c.conversation_id
             FROM conversations c
             WHERE ${definition.predicateSql}
           )
         ), 0) AS message_count
       FROM conversations c
       WHERE ${definition.predicateSql}`,
    )
    .get() as CleanerCountRow | undefined;

  const examples = db
    .prepare(
      `SELECT
         c.conversation_id,
         c.session_key,
         COALESCE(msg_stats.message_count, 0) AS message_count,
         (
           SELECT m.content
           FROM messages m
           WHERE m.conversation_id = c.conversation_id
           ORDER BY m.seq ASC, m.created_at ASC, m.message_id ASC
           LIMIT 1
         ) AS first_message_preview
       FROM conversations c
       LEFT JOIN (
         SELECT conversation_id, COUNT(*) AS message_count
         FROM messages
         GROUP BY conversation_id
       ) msg_stats ON msg_stats.conversation_id = c.conversation_id
       WHERE ${definition.predicateSql}
       ORDER BY COALESCE(msg_stats.message_count, 0) DESC, c.created_at DESC, c.conversation_id DESC
       LIMIT 3`,
    )
    .all() as CleanerExampleRow[];

  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    conversationCount: counts?.conversation_count ?? 0,
    messageCount: counts?.message_count ?? 0,
    examples: examples.map((row) => ({
      conversationId: row.conversation_id,
      sessionKey: row.session_key ?? null,
      messageCount: row.message_count ?? 0,
      firstMessagePreview: truncatePreview(row.first_message_preview ?? null),
    })),
  };
}

export function getDoctorCleanerFilters(): Array<Pick<DoctorCleanerFilterStat, "id" | "label" | "description">> {
  return CLEANER_DEFINITIONS.map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
}

export function scanDoctorCleaners(
  db: DatabaseSync,
  filterIds?: DoctorCleanerId[],
): DoctorCleanerScan {
  const definitions = getCleanerDefinitions(filterIds);
  const filters = definitions.map((definition) => scanSingleCleaner(db, definition));
  const distinctUnionSql = buildDistinctUnionSql(definitions);
  const totals = db
    .prepare(
      `WITH matched_conversations AS (
         ${distinctUnionSql}
       )
       SELECT
         COALESCE((SELECT COUNT(*) FROM matched_conversations), 0) AS conversation_count,
         COALESCE((
           SELECT COUNT(*)
           FROM messages m
           WHERE m.conversation_id IN (SELECT conversation_id FROM matched_conversations)
         ), 0) AS message_count`,
    )
    .get() as CleanerCountRow | undefined;

  return {
    filters,
    totalDistinctConversations: totals?.conversation_count ?? 0,
    totalDistinctMessages: totals?.message_count ?? 0,
  };
}
