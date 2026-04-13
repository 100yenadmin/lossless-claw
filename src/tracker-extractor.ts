import { type TrackerKind, type TrackerRow, TrackerStore } from "./store/tracker-store.js";

const OPEN_PATTERNS: Array<{ kind: TrackerKind; pattern: RegExp }> = [
  {
    kind: "blocker",
    pattern:
      /\b(blocked|blocker|stuck|waiting on|depends on|can't proceed|cannot proceed|held up|failing|broken|error|issue|pending)\b/i,
  },
  {
    kind: "open_item",
    pattern:
      /\b(todo|to do|follow up|follow-up|revisit|still need|need to|tbd|open item|open loop|next step|pending)\b/i,
  },
  {
    kind: "decision",
    pattern: /\b(decision|decide|need to decide|choose|choice pending|pick between)\b/i,
  },
  {
    kind: "question",
    pattern: /\?|\b(question|open question|unclear|unknown|investigate|figure out)\b/i,
  },
];

const RESOLUTION_PATTERNS =
  /\b(completed|done|finished|shipped|merged|deployed|landed|released|published|closed|resolved|fixed|delivered|pushed|cut|went live|launched)\b/i;

export interface ExtractTrackerParams {
  conversationId: number;
  dateKey: string;
  rollupId: string;
  rollupContent: string;
  trackerStore: TrackerStore;
}

export function extractTrackersFromRollup(params: ExtractTrackerParams): void {
  const sections = parseSections(params.rollupContent);
  const openLines = dedupeNormalized([
    ...sections.blockers,
    ...sections.openItems,
    ...sections.decisions,
    ...sections.questions,
  ]);
  const resolutionLines = dedupeNormalized([...sections.completed, ...sections.timelineResolved]);
  const existingOpenTrackers = params.trackerStore.getOpenTrackers(params.conversationId);

  for (const tracker of existingOpenTrackers) {
    const resolutionMatch = resolutionLines.find((line) => isResolvedByLine(tracker.content, line));
    if (resolutionMatch) {
      params.trackerStore.resolveTracker(tracker.tracker_id, params.dateKey, params.rollupId);
    }
  }

  const remainingOpenTrackers = params.trackerStore.getOpenTrackers(params.conversationId);

  for (const line of openLines) {
    const kind = classifyLine(line);
    if (!kind) {
      continue;
    }
    const alreadyTracked = remainingOpenTrackers.some((tracker) => isSameTracker(tracker, kind, line));
    if (alreadyTracked) {
      continue;
    }
    params.trackerStore.createTracker({
      conversation_id: params.conversationId,
      kind,
      content: line,
      source_rollup_id: params.rollupId,
      source_day: params.dateKey,
    });
  }
}

function parseSections(content: string): {
  blockers: string[];
  openItems: string[];
  decisions: string[];
  questions: string[];
  completed: string[];
  timelineResolved: string[];
} {
  const lines = content.split(/\r?\n/);
  const blockers: string[] = [];
  const openItems: string[] = [];
  const decisions: string[] = [];
  const questions: string[] = [];
  const completed: string[] = [];
  const timelineResolved: string[] = [];

  let section = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("## ")) {
      section = line.toLowerCase();
      continue;
    }
    if (!line.startsWith("- ")) {
      continue;
    }

    const cleaned = stripBulletPrefix(line);
    if (!cleaned || cleaned.toLowerCase() === "none") {
      continue;
    }

    if (section.includes("activity timeline") && RESOLUTION_PATTERNS.test(cleaned)) {
      timelineResolved.push(cleaned);
    }

    if (section.includes("key items")) {
      if (cleaned.toLowerCase().startsWith("decisions:")) {
        decisions.push(...splitInlineList(cleaned.slice("decisions:".length)));
      } else if (cleaned.toLowerCase().startsWith("completed:")) {
        completed.push(...splitInlineList(cleaned.slice("completed:".length)));
      } else if (cleaned.toLowerCase().startsWith("blockers:")) {
        blockers.push(...splitInlineList(cleaned.slice("blockers:".length)));
      } else if (cleaned.toLowerCase().startsWith("open items:")) {
        openItems.push(...splitInlineList(cleaned.slice("open items:".length)));
      }
    }

    if (classifyLine(cleaned) === "question") {
      questions.push(cleaned);
    }
  }

  return { blockers, openItems, decisions, questions, completed, timelineResolved };
}

function splitInlineList(value: string): string[] {
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "none") {
    return [];
  }
  return normalized
    .split(/;|\s\|\s/)
    .map((item) => normalizeLine(item))
    .filter(Boolean);
}

function classifyLine(line: string): TrackerKind | null {
  const normalized = line.toLowerCase();
  if (normalized.includes("follow up") || normalized.includes("follow-up") || normalized.includes("todo") || normalized.includes("still need") || normalized.includes("open item") || normalized.includes("open loop")) {
    return "open_item";
  }
  if (normalized.includes("blocked") || normalized.includes("blocker") || normalized.includes("waiting on") || normalized.includes("depends on") || normalized.includes("stuck") || normalized.includes("error") || normalized.includes("issue")) {
    return "blocker";
  }
  if (normalized.includes("need to decide") || normalized.includes("decision") || normalized.includes("decide") || normalized.includes("choose")) {
    return "decision";
  }
  for (const entry of OPEN_PATTERNS) {
    if (entry.pattern.test(line)) {
      return entry.kind;
    }
  }
  return null;
}

function isSameTracker(tracker: TrackerRow, kind: TrackerKind, line: string): boolean {
  if (tracker.kind !== kind) {
    return false;
  }
  return fuzzyOverlap(tracker.content, line) >= 0.6;
}

function isResolvedByLine(content: string, resolvedLine: string): boolean {
  return fuzzyOverlap(content, resolvedLine) > 0.6;
}

function fuzzyOverlap(left: string, right: string): number {
  const leftWords = tokenize(left);
  const rightWords = tokenize(right);
  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      overlap += 1;
    }
  }
  return overlap / leftWords.size;
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalizeLine(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3),
  );
}

function dedupeNormalized(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const normalized = normalizeLine(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeLine(value: string): string {
  return stripBulletPrefix(value).replace(/\s+/g, " ").trim();
}

function stripBulletPrefix(value: string): string {
  return value.replace(/^[-*•\d.)\s\[]+/, "").replace(/^\d{2}:\d{2}\]\s*/, "").trim();
}
