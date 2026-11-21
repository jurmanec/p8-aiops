import type { StoredEvent } from "./log.ts";

export type ResponseAction = "WORKING_ON_IT" | "IGNORE_IT";

/** How a FIRING relates to an already-open episode (plan 006 §1). */
export type FiringArrival =
  | { kind: "open"; previousSeverity: null; openingEventId: null }
  | { kind: "repeat"; previousSeverity: string | null; openingEventId: string }
  | { kind: "severity_update"; previousSeverity: string | null; openingEventId: string };

export type Thread = {
  alertKey: string;
  firingEventId: string;
  openedAt: string;
  attention: "recorded" | "open" | "owned" | "ignored";
  condition: "firing" | "cleared";
  contact: "none";
  /** Latest FIRING severity on this episode (behavior / current state). */
  severity: string | null;
  /** Highest severity seen on this episode (list / report display). */
  peakSeverity: string | null;
  team: string | null;
  manualPresent: boolean;
  message: string | null;
  response: { action: ResponseAction; note: string | null } | null;
  done: { note: string | null } | null;
  escalation: { next: string } | null;
  eventIds: string[];
};

/** critical > warning > info > unknown/null. */
export function severityRank(severity: string | null): number {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  if (severity === "info") return 1;
  return 0;
}

/**
 * Classify a FIRING for `alertKey` relative to prior log events.
 * `currentEventId` is excluded so classification works after intake has saved the row.
 */
export function classifyFiringArrival(
  events: StoredEvent[],
  alertKey: string,
  currentEventId: string,
  newSeverity: string | null,
): FiringArrival {
  let lastTransition: "FIRING" | "RESOLVED" | null = null;
  let previousSeverity: string | null = null;
  let openingEventId: string | null = null;

  const ordered = [...events].sort(
    (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.eventId.localeCompare(b.eventId),
  );

  for (const event of ordered) {
    if (event.eventId === currentEventId || isProjectionMeta(event.eventId)) continue;
    const body = JSON.parse(event.body) as Record<string, unknown>;
    if (body.event_id === currentEventId) continue;
    if (body.alert_key !== alertKey) continue;
    if (body.transition === "FIRING") {
      if (lastTransition !== "FIRING") {
        openingEventId = typeof body.event_id === "string" && body.event_id.length > 0 ? body.event_id : event.eventId;
      }
      lastTransition = "FIRING";
      previousSeverity = typeof body.severity === "string" && body.severity.length > 0 ? body.severity : null;
      continue;
    }
    if (body.transition === "RESOLVED") {
      lastTransition = "RESOLVED";
      previousSeverity = null;
      openingEventId = null;
    }
  }

  if (lastTransition !== "FIRING" || openingEventId === null) {
    return { kind: "open", previousSeverity: null, openingEventId: null };
  }
  if (previousSeverity === newSeverity) {
    return { kind: "repeat", previousSeverity, openingEventId };
  }
  return { kind: "severity_update", previousSeverity, openingEventId };
}

type Episode = {
  alertKey: string;
  firingEventId: string;
  openedAt: string;
  seenFire: boolean;
  seenResolve: boolean;
  attention: Thread["attention"];
  severity: string | null;
  peakSeverity: string | null;
  team: string | null;
  manualPresent: boolean;
  message: string | null;
  response: Thread["response"];
  done: Thread["done"];
  escalation: Thread["escalation"];
  eventIds: string[];
};

/** One row per episode. A firing after a resolve starts a new episode on the same alert key. */
export function projectThreads(events: StoredEvent[]): Thread[] {
  const byKey = new Map<string, Episode[]>();
  const ordered = [...events].sort(
    (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.eventId.localeCompare(b.eventId),
  );

  for (const event of ordered) {
    const body = JSON.parse(event.body) as Record<string, unknown>;
    if (isResponse(event.eventId)) {
      applyResponse(byKey, event, body);
      continue;
    }
    if (isEscalation(event.eventId)) {
      applyEscalation(byKey, event, body);
      continue;
    }
    if (event.eventId.startsWith("done:")) {
      applyDone(byKey, event, body);
      continue;
    }
    if (event.eventId.startsWith("reply:")) {
      applyReply(byKey, event, body);
      continue;
    }
    if (isProjectionMeta(event.eventId)) continue;
    if (typeof body.alert_key !== "string" || body.alert_key.length === 0) continue;

    if (body.transition === "RESOLVED") applyResolve(byKey, event, body);
    if (body.transition === "FIRING") applyFiring(byKey, event, body);
  }

  return [...byKey.values()]
    .flat()
    .map(toThread)
    .sort(
      (a, b) =>
        b.openedAt.localeCompare(a.openedAt) ||
        a.alertKey.localeCompare(b.alertKey) ||
        a.firingEventId.localeCompare(b.firingEventId),
    );
}

function applyFiring(byKey: Map<string, Episode[]>, event: StoredEvent, body: Record<string, unknown>): void {
  const open = openEpisode(byKey, body.alert_key as string);
  if (open) {
    open.eventIds.push(event.eventId);
    // Same open episode: refresh severity (and other envelope facts) on change or repeat.
    // Opening event id and openedAt stay. Done reconsider is plan 006 §4.
    const wasRecorded = open.attention === "recorded";
    const wasDone = open.done !== null;
    copyFacts(open, body);
    // First critical (§3) or re-critical after Done (§4): reopen attention.
    if (body.severity === "critical" && (wasRecorded || wasDone)) {
      open.attention = "open";
      open.done = null;
      open.message = messageText(body);
    }
    return;
  }
  const episode = emptyEpisode(body.alert_key as string, event.eventId, event.receivedAt);
  episode.seenFire = true;
  episode.eventIds.push(event.eventId);
  copyFacts(episode, body);
  if (body.severity === "critical") {
    episode.attention = "open";
    episode.message = messageText(body);
  }
  episodes(byKey, episode.alertKey).push(episode);
}

function applyResolve(byKey: Map<string, Episode[]>, event: StoredEvent, body: Record<string, unknown>): void {
  const alertKey = body.alert_key as string;
  const open = openEpisode(byKey, alertKey);
  if (open) {
    open.seenResolve = true;
    open.eventIds.push(event.eventId);
    return;
  }
  const latest = lastEpisode(byKey, alertKey);
  if (latest) {
    latest.eventIds.push(event.eventId);
    return;
  }
  const episode = emptyEpisode(alertKey, event.eventId, event.receivedAt);
  episode.seenResolve = true;
  episode.eventIds.push(event.eventId);
  copyFacts(episode, body);
  episodes(byKey, alertKey).push(episode);
}

function applyEscalation(byKey: Map<string, Episode[]>, event: StoredEvent, body: Record<string, unknown>): void {
  if (typeof body.alert_key !== "string" || typeof body.next !== "string" || body.next.length === 0) return;
  const episode = episodeAt(byKey, body.alert_key, event.receivedAt);
  if (!episode || episode.attention !== "open" || episode.escalation) return;
  episode.escalation = { next: body.next };
  episode.eventIds.push(event.eventId);
}

function applyReply(byKey: Map<string, Episode[]>, event: StoredEvent, body: Record<string, unknown>): void {
  if (typeof body.alert_key !== "string" || typeof body.firing_event_id !== "string" || body.firing_event_id.length === 0) return;
  if (typeof body.text !== "string" || body.text.length === 0) return;
  const episode = (byKey.get(body.alert_key) ?? []).find((item) => item.firingEventId === body.firing_event_id);
  if (!episode) return;
  episode.eventIds.push(event.eventId);
}

function applyDone(byKey: Map<string, Episode[]>, event: StoredEvent, body: Record<string, unknown>): void {
  if (typeof body.alert_key !== "string") return;
  const episode = episodeForClick(byKey, body, event.receivedAt);
  if (!episode || episode.attention === "recorded") return;
  episode.attention = "owned";
  episode.done = {
    note: typeof body.note === "string" && body.note.length > 0 ? body.note : null,
  };
  episode.eventIds.push(event.eventId);
}

function applyResponse(byKey: Map<string, Episode[]>, event: StoredEvent, body: Record<string, unknown>): void {
  if (typeof body.alert_key !== "string") return;
  const episode = episodeForClick(byKey, body, event.receivedAt);
  if (!episode || episode.attention === "recorded") return;
  if (body.action !== "WORKING_ON_IT" && body.action !== "IGNORE_IT") return;
  episode.attention = body.action === "WORKING_ON_IT" ? "owned" : "ignored";
  episode.response = {
    action: body.action,
    note: typeof body.note === "string" && body.note.length > 0 ? body.note : null,
  };
  episode.done = null;
  episode.eventIds.push(event.eventId);
}

function openEpisode(byKey: Map<string, Episode[]>, alertKey: string): Episode | undefined {
  const latest = lastEpisode(byKey, alertKey);
  if (latest && latest.seenFire && !latest.seenResolve) return latest;
  return undefined;
}

function episodeForClick(byKey: Map<string, Episode[]>, body: Record<string, unknown>, receivedAt: string): Episode | undefined {
  const alertKey = body.alert_key as string;
  if (typeof body.firing_event_id === "string" && body.firing_event_id.length > 0) {
    return (byKey.get(alertKey) ?? []).find((episode) => episode.firingEventId === body.firing_event_id);
  }
  return episodeAt(byKey, alertKey, receivedAt);
}

function episodeAt(byKey: Map<string, Episode[]>, alertKey: string, receivedAt: string): Episode | undefined {
  let found: Episode | undefined;
  for (const episode of byKey.get(alertKey) ?? []) {
    if (episode.openedAt <= receivedAt) found = episode;
  }
  return found;
}

function lastEpisode(byKey: Map<string, Episode[]>, alertKey: string): Episode | undefined {
  const list = byKey.get(alertKey);
  return list?.[list.length - 1];
}

function episodes(byKey: Map<string, Episode[]>, alertKey: string): Episode[] {
  const list = byKey.get(alertKey) ?? [];
  byKey.set(alertKey, list);
  return list;
}

function emptyEpisode(alertKey: string, firingEventId: string, openedAt: string): Episode {
  return {
    alertKey,
    firingEventId,
    openedAt,
    seenFire: false,
    seenResolve: false,
    attention: "recorded",
    severity: null,
    peakSeverity: null,
    team: null,
    manualPresent: false,
    message: null,
    response: null,
    done: null,
    escalation: null,
    eventIds: [],
  };
}

function toThread(episode: Episode): Thread {
  return {
    alertKey: episode.alertKey,
    firingEventId: episode.firingEventId,
    openedAt: episode.openedAt,
    attention: episode.attention,
    condition: episode.seenResolve ? "cleared" : "firing",
    contact: "none",
    severity: episode.severity,
    peakSeverity: episode.peakSeverity,
    team: episode.team,
    manualPresent: episode.manualPresent,
    message: episode.message,
    response: episode.response,
    done: episode.done,
    escalation: episode.escalation,
    eventIds: episode.eventIds,
  };
}

export function responseEventId(alertKey: string): string {
  return `response:${alertKey}`;
}

function isResponse(eventId: string): boolean {
  return eventId.startsWith("response:");
}

function isEscalation(eventId: string): boolean {
  return eventId.startsWith("escalation:");
}

function isProjectionMeta(eventId: string): boolean {
  return (
    eventId.startsWith("shift:") ||
    eventId.startsWith("slack:") ||
    eventId.startsWith("response:") ||
    eventId.startsWith("escalation:") ||
    eventId.startsWith("done:") ||
    eventId.startsWith("reply:")
  );
}

function messageText(body: Record<string, unknown>): string {
  const lines = ["Critical alert is firing."];
  if (typeof body.summary === "string" && body.summary.length > 0) lines.push(body.summary);
  if (typeof body.manual_url === "string" && body.manual_url.length > 0) lines.push(`Manual: ${body.manual_url}`);
  else lines.push("No manual link.");
  lines.push("Press a button. Keep follow-up notes, including the note that closes the loop, on this message.");
  return lines.join("\n");
}

function copyFacts(episode: Episode, body: Record<string, unknown>): void {
  episode.severity = typeof body.severity === "string" ? body.severity : null;
  if (severityRank(episode.severity) > severityRank(episode.peakSeverity)) {
    episode.peakSeverity = episode.severity;
  }
  episode.team = typeof body.team === "string" && body.team.length > 0 ? body.team : null;
  episode.manualPresent = typeof body.manual_url === "string" && body.manual_url.length > 0;
}
