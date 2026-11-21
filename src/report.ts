import type { AlertLog, StoredEvent } from "./log.ts";
import { projectThreads, type ResponseAction, type Thread } from "./thread.ts";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export type ShiftThread = {
  alertKey: string;
  firingEventId: string;
  severity: string | null;
  manualPresent: boolean;
  condition: Thread["condition"];
  attention: Thread["attention"];
  answer: ResponseAction | null;
  note: string | null;
  done: boolean;
  doneNote: string | null;
  discrepancy: "human done, condition still firing" | "condition cleared, human not done" | null;
  answerMs: number | null;
  escalation: string | null;
  open: boolean;
};

export type ShiftReport = {
  start: string;
  end: string;
  model: null;
  threads: ShiftThread[];
  openCount: number;
};

export function shiftEventId(start: string, end: string): string {
  return `shift:${start}:${end}`;
}

export function validateShift(body: unknown): { ok: true; start: string; end: string } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: "body must be a JSON object" };
  if (!isTimestamp(body.start) || !isTimestamp(body.end)) {
    return { ok: false, error: "start and end must be UTC timestamps" };
  }
  if (Date.parse(body.start) >= Date.parse(body.end)) return { ok: false, error: "start must be before end" };
  return { ok: true, start: body.start, end: body.end };
}

export function buildShiftReport(events: StoredEvent[], start: string, end: string): ShiftReport {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const visible = events.filter((event) => Date.parse(event.receivedAt) < endMs && !event.eventId.startsWith("shift:"));
  const threads = projectThreads(visible)
    .filter((thread) => {
      const opened = Date.parse(thread.openedAt);
      return opened >= startMs && opened < endMs;
    })
    .map((thread) => toShiftThread(thread, visible));

  return {
    start,
    end,
    model: null,
    threads,
    openCount: threads.filter((thread) => thread.open).length,
  };
}

export function closeShift(log: AlertLog, start: string, end: string): { created: boolean; report: ShiftReport } {
  const id = shiftEventId(start, end);
  const existing = log.get(id);
  if (existing) return { created: false, report: JSON.parse(existing.body) as ShiftReport };
  const report = buildShiftReport(log.list(), start, end);
  const saved = log.save(id, JSON.stringify(report), end);
  if (saved === "duplicate") {
    return { created: false, report: JSON.parse(log.get(id)?.body ?? "{}") as ShiftReport };
  }
  return { created: true, report };
}

function toShiftThread(thread: Thread, events: StoredEvent[]): ShiftThread {
  return {
    alertKey: thread.alertKey,
    firingEventId: thread.firingEventId,
    // Report shows peak severity for the episode; timeline on alerts has the path.
    severity: thread.peakSeverity ?? thread.severity,
    manualPresent: thread.manualPresent,
    condition: thread.condition,
    attention: thread.attention,
    answer: thread.response?.action ?? null,
    note: thread.response?.note ?? null,
    done: thread.done !== null,
    doneNote: thread.done?.note ?? null,
    discrepancy: discrepancy(thread),
    answerMs: answerMs(events, thread),
    escalation: thread.escalation?.next ?? null,
    open: thread.attention === "open",
  };
}

function discrepancy(thread: Thread): ShiftThread["discrepancy"] {
  if (!thread.message) return null;
  const humanDone = thread.done !== null;
  const cleared = thread.condition === "cleared";
  if (humanDone && !cleared) return "human done, condition still firing";
  if (!humanDone && cleared) return "condition cleared, human not done";
  return null;
}

function answerMs(events: StoredEvent[], thread: Thread): number | null {
  const ids = new Set(thread.eventIds);
  let opened: number | null = null;
  let answered: number | null = null;
  for (const event of events) {
    if (!ids.has(event.eventId)) continue;
    if (answered === null && event.eventId.startsWith("response:")) answered = Date.parse(event.receivedAt);
    if (opened === null && !isAside(event.eventId)) {
      const body = JSON.parse(event.body) as Record<string, unknown>;
      if (body.transition === "FIRING") opened = Date.parse(event.receivedAt);
    }
  }
  if (opened === null || answered === null) return null;
  return answered - opened;
}

function isAside(eventId: string): boolean {
  return eventId.startsWith("response:") || eventId.startsWith("escalation:") || eventId.startsWith("done:") || eventId.startsWith("slack:") || eventId.startsWith("reply:");
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
