import type { AlertLog } from "./log.ts";
import { projectThreads, responseEventId, type ResponseAction } from "./thread.ts";

export type HumanAction = ResponseAction | "DONE";

const MAX_NOTE_LENGTH = 2000;

export type HumanResponse = {
  alertKey: string;
  action: HumanAction;
  note: string | null;
  actor?: string | null;
  firingEventId?: string | null;
};

export type ResponseValidation = { ok: true; value: HumanResponse } | { ok: false; error: string };

export function validateResponse(body: unknown): ResponseValidation {
  if (!isObject(body)) return { ok: false, error: "body must be a JSON object" };
  if (typeof body.alert_key !== "string" || body.alert_key.length === 0) {
    return { ok: false, error: "alert_key must be a non-empty string" };
  }
  if (body.action !== "WORKING_ON_IT" && body.action !== "IGNORE_IT" && body.action !== "DONE") {
    return { ok: false, error: "action must be WORKING_ON_IT, IGNORE_IT, or DONE" };
  }
  if ("note" in body && typeof body.note !== "string") return { ok: false, error: "note must be a string" };
  if (typeof body.note === "string" && body.note.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: "note is too long" };
  }
  if ("firing_event_id" in body && (typeof body.firing_event_id !== "string" || body.firing_event_id.length === 0)) {
    return { ok: false, error: "firing_event_id must be a non-empty string" };
  }
  return {
    ok: true,
    value: {
      alertKey: body.alert_key,
      action: body.action,
      note: typeof body.note === "string" && body.note.length > 0 ? body.note : null,
      firingEventId: typeof body.firing_event_id === "string" ? body.firing_event_id : null,
    },
  };
}

export function applyHumanResponse(log: AlertLog, value: HumanResponse): { status: number; error?: string; receivedAt?: string } {
  const threads = projectThreads(log.list());
  const thread = value.firingEventId
    ? threads.find((item) => item.alertKey === value.alertKey && item.firingEventId === value.firingEventId)
    : threads.find((item) => item.alertKey === value.alertKey);
  if (!thread) return { status: 404, error: "thread not found" };
  if (thread.attention === "recorded") return { status: 409, error: "thread is not awaiting a response" };
  const latest = value.firingEventId ? latestClickFor(log, value.alertKey, value.firingEventId) : latestClick(log, value.alertKey);
  const firingAt = value.firingEventId ? null : latestFiringAt(log, value.alertKey);
  if (latest && (value.firingEventId || firingAt === null || latest.receivedAt >= firingAt) && sameClick(latest, value)) {
    return { status: 200, receivedAt: latest.receivedAt };
  }
  const receivedAt = clickTime();
  const raw = JSON.stringify({
    alert_key: value.alertKey,
    action: value.action,
    note: value.note,
    ...(value.actor ? { actor: value.actor } : {}),
    ...(value.firingEventId ? { firing_event_id: value.firingEventId } : {}),
  });
  log.save(clickEventId(log, value, receivedAt), raw, receivedAt);
  return { status: 202, receivedAt };
}

function clickEventId(log: AlertLog, value: HumanResponse, receivedAt: string): string {
  if (value.action !== "DONE" && !log.get(responseEventId(value.alertKey))) return responseEventId(value.alertKey);
  const prefix = value.action === "DONE" ? `done:${value.alertKey}:` : `response:${value.alertKey}:`;
  const prior = log.list().filter((event) => event.eventId.startsWith(prefix)).length;
  return `${prefix}${receivedAt}:${prior}`;
}

function latestClickFor(
  log: AlertLog,
  alertKey: string,
  firingEventId: string,
): { action: string; note: string | null; actor: string | null; receivedAt: string } | null {
  let found: { action: string; note: string | null; actor: string | null; receivedAt: string } | null = null;
  for (const event of log.list()) {
    if (!event.eventId.startsWith("response:") && !event.eventId.startsWith("done:")) continue;
    const body = JSON.parse(event.body) as { alert_key?: string; firing_event_id?: string; action?: string; note?: string; actor?: string };
    if (body.alert_key !== alertKey || body.firing_event_id !== firingEventId || typeof body.action !== "string") continue;
    found = clickFrom(body.action, body, event.receivedAt);
  }
  return found;
}

function latestClick(log: AlertLog, alertKey: string): { action: string; note: string | null; actor: string | null; receivedAt: string } | null {
  let found: { action: string; note: string | null; actor: string | null; receivedAt: string } | null = null;
  for (const event of log.list()) {
    if (!event.eventId.startsWith("response:") && !event.eventId.startsWith("done:")) continue;
    const body = JSON.parse(event.body) as { alert_key?: string; action?: string; note?: string; actor?: string };
    if (body.alert_key !== alertKey || typeof body.action !== "string") continue;
    found = clickFrom(body.action, body, event.receivedAt);
  }
  return found;
}

function clickFrom(
  action: string,
  body: { note?: string; actor?: string },
  receivedAt: string,
): { action: string; note: string | null; actor: string | null; receivedAt: string } {
  return {
    action,
    note: typeof body.note === "string" && body.note.length > 0 ? body.note : null,
    actor: typeof body.actor === "string" && body.actor.length > 0 ? body.actor : null,
    receivedAt,
  };
}

function latestFiringAt(log: AlertLog, alertKey: string): string | null {
  let at: string | null = null;
  for (const event of log.list()) {
    if (event.eventId.startsWith("response:") || event.eventId.startsWith("done:") || event.eventId.startsWith("slack:") || event.eventId.startsWith("shift:") || event.eventId.startsWith("escalation:") || event.eventId.startsWith("reply:")) {
      continue;
    }
    const body = JSON.parse(event.body) as { alert_key?: string; transition?: string };
    if (body.alert_key === alertKey && body.transition === "FIRING") at = event.receivedAt;
  }
  return at;
}

function sameClick(
  latest: { action: string; note: string | null; actor: string | null },
  value: HumanResponse,
): boolean {
  const actor = value.actor ?? null;
  return latest.action === value.action && latest.note === value.note && (!actor || !latest.actor || actor === latest.actor);
}

let lastClickMs = 0;

function clickTime(): string {
  const ms = Math.max(Date.now(), lastClickMs + 1);
  lastClickMs = ms;
  return new Date(ms).toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
