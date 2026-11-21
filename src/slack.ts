import { createHmac, timingSafeEqual } from "node:crypto";
import type { AlertLog } from "./log.ts";
import type { HumanAction } from "./response.ts";
import { classifyFiringArrival, projectThreads } from "./thread.ts";

export type SlackPost = {
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: unknown[];
};

export type SlackSender = {
  postMessage(input: SlackPost): Promise<{ ts: string }>;
  update(input: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
};

export function slackEventId(alertKey: string, firingEventId: string): string {
  return `slack:${alertKey}:${firingEventId}`;
}

export type SlackClick = {
  alertKey: string;
  action: HumanAction;
  firingEventId: string | null;
  threadTs: string | null;
};

type SlackParent = {
  alert_key: string;
  channel: string;
  ts: string;
  solicit_ts: string | null;
  firing_event_id: string;
};

export function slackConfig(env: NodeJS.ProcessEnv): { token: string; channel: string } | null {
  if (env.SLACK_POST !== "1") return null;
  const token = env.SLACK_BOT_TOKEN?.trim() ?? "";
  const channel = env.SLACK_CHANNEL_ID?.trim() ?? "";
  if (!token || !channel) return null;
  return { token, channel };
}

export function solicitText(): string {
  return "Press a button. Keep follow-up notes, including the note that closes the loop, on this message.";
}

/** Solicit after severity returns to critical when the person had marked Done (plan 006 §4). */
export function reconsiderSolicitText(): string {
  return "Severity is critical again after Done. Reconsider attention — press a button.";
}

const MAX_SIGNATURE_AGE_SECONDS = 60 * 5;

export function verifySlackSignature(raw: string, timestamp: string | undefined, signature: string | undefined, secret: string): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > MAX_SIGNATURE_AGE_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function slackPayload(raw: string): unknown {
  const encoded = new URLSearchParams(raw).get("payload");
  if (!encoded) return null;
  try {
    return JSON.parse(encoded);
  } catch {
    return null;
  }
}

export function slackActor(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const user = (payload as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const record = user as { username?: unknown; name?: unknown; id?: unknown };
  if (typeof record.username === "string" && record.username.length > 0) return record.username;
  if (typeof record.name === "string" && record.name.length > 0) return record.name;
  if (typeof record.id === "string" && record.id.length > 0) return record.id;
  return null;
}

export function stateLabel(action: HumanAction): string {
  if (action === "WORKING_ON_IT") return "In progress";
  if (action === "IGNORE_IT") return "Non actionable";
  return "Done";
}

export function solicitLine(action: HumanAction): string {
  return `State: \`${stateLabel(action)}\``;
}

export function threadLine(action: HumanAction, name: string): string {
  return `\`${stateLabel(action)}\` ${who(name)}`;
}

function who(name: string): string {
  return name.length > 0 ? name : "Someone";
}

export function slackButton(payload: unknown): SlackClick | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const actions = (payload as { actions?: unknown }).actions;
  const action = Array.isArray(actions) ? actions[0] : null;
  if (typeof action !== "object" || action === null) return null;
  const id = (action as { action_id?: unknown }).action_id;
  const value = (action as { value?: unknown }).value;
  const named = typeof value === "string" ? buttonValue(value) : null;
  if ((id !== "WORKING_ON_IT" && id !== "IGNORE_IT" && id !== "DONE") || !named) return null;
  return { alertKey: named.alertKey, action: id, firingEventId: named.firingEventId, threadTs: threadTsOf(payload) };
}

export type SlackReply = {
  channel: string;
  ts: string;
  threadTs: string;
  text: string;
  /** Display name when resolved; otherwise the Slack user id. */
  actor: string;
  /** Slack user id when actor was resolved to a display name. */
  actorId?: string;
};

/** Looks up a Slack user id and returns a display name, or null when the lookup fails. */
export type SlackUserLookup = (userId: string) => Promise<string | null>;

export function replyEventId(channel: string, ts: string): string {
  return `reply:${channel}:${ts}`;
}

/** Slack's URL check. The challenge is returned as JSON and is not stored. */
export function slackChallenge(payload: unknown): string | null {
  if (!isPayload(payload) || payload.type !== "url_verification") return null;
  return typeof payload.challenge === "string" && payload.challenge.length > 0 ? payload.challenge : null;
}

/** A person's typed reply in a thread. Bot lines and top-level messages are left out. */
export function slackReply(payload: unknown): SlackReply | null {
  if (!isPayload(payload) || payload.type !== "event_callback") return null;
  const event = objectOf(payload.event);
  if (!event || event.type !== "message") return null;
  if (typeof event.subtype === "string" || typeof event.bot_id === "string") return null;
  if (typeof event.user !== "string" || event.user.length === 0) return null;
  if (typeof event.text !== "string" || event.text.trim().length === 0) return null;
  if (typeof event.thread_ts !== "string" || event.thread_ts.length === 0) return null;
  if (typeof event.ts !== "string" || event.ts.length === 0 || event.ts === event.thread_ts) return null;
  if (typeof event.channel !== "string" || event.channel.length === 0) return null;
  return { channel: event.channel, ts: event.ts, threadTs: event.thread_ts, text: event.text.trim(), actor: event.user };
}

/** Replace the Slack user id with a display name when a lookup is available. */
export async function resolveReplyActor(reply: SlackReply, lookup: SlackUserLookup | null): Promise<SlackReply> {
  if (!lookup || reply.actorId) return reply;
  const name = await lookup(reply.actor);
  if (!name || name === reply.actor) return reply;
  return { ...reply, actor: name, actorId: reply.actor };
}

/** users.info with an in-process cache. Needs the users:read bot scope. */
export function liveUserLookup(token: string): SlackUserLookup {
  const cache = new Map<string, string>();
  return async (userId) => {
    const hit = cache.get(userId);
    if (hit) return hit;
    try {
      // users.info does not accept application/json; Slack drops the user arg and returns user_not_found.
      const payload = await call(token, "users.info", { user: userId }, "form");
      const name = displayNameOf(payload.user);
      if (!name) return null;
      cache.set(userId, name);
      return name;
    } catch {
      return null;
    }
  };
}

/** Store the reply on the firing whose top-level message is this thread. An unknown thread is ignored. */
export function recordReply(log: AlertLog, reply: SlackReply): "saved" | "duplicate" | "ignored" {
  const parent = parentByThreadTs(log, reply.threadTs);
  if (!parent) return "ignored";
  const body = JSON.stringify({
    alert_key: parent.alert_key,
    firing_event_id: parent.firing_event_id,
    text: reply.text,
    actor: reply.actor,
    ...(reply.actorId ? { actor_id: reply.actorId } : {}),
    channel: reply.channel,
    ts: reply.ts,
    thread_ts: reply.threadTs,
  });
  return log.save(replyEventId(reply.channel, reply.ts), body, new Date().toISOString());
}

/** The thread's top-level message names the episode. The button's firing id is used when that parent is not stored. */
export function clickEpisode(log: AlertLog, click: SlackClick): { alertKey: string; firingEventId: string | null } {
  if (click.threadTs) {
    const parent = parentByThreadTs(log, click.threadTs);
    if (parent) return { alertKey: parent.alert_key, firingEventId: parent.firing_event_id };
  }
  return { alertKey: click.alertKey, firingEventId: click.firingEventId };
}

export function slackReplacement(alertKey: string, firingEventId: string | null, sentence: string, error?: string): Record<string, unknown> {
  if (error) return { replace_original: false, text: error };
  return { replace_original: true, text: sentence, blocks: stateBlocks(alertKey, firingEventId, sentence) };
}

export function stateBlocks(alertKey: string, firingEventId: string | null, sentence: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: sentence } },
    {
      type: "actions",
      elements: actionButtons(alertKey, firingEventId),
    },
  ];
}

export async function showClick(
  log: AlertLog,
  sender: SlackSender,
  channel: string,
  alertKey: string,
  firingEventId: string | null,
  solicit: string,
  thread: string,
  threadReply: boolean,
): Promise<void> {
  if (!firingEventId) return;
  const stored = findParent(log, alertKey, firingEventId);
  if (!stored) return;
  const parent = parseParent(stored.body);
  if (!parent) return;
  const slackChannel = parent.channel.length > 0 ? parent.channel : channel;
  if (parent.solicit_ts) {
    await sender.update({
      channel: slackChannel,
      ts: parent.solicit_ts,
      text: solicit,
      blocks: stateBlocks(alertKey, firingEventId, solicit),
    });
  }
  if (threadReply && parent.ts.length > 0) {
    await sender.postMessage({ channel: slackChannel, text: thread, threadTs: parent.ts });
  }
}

export function solicitBlocks(alertKey: string, firingEventId: string): unknown[] {
  return [{ type: "actions", elements: actionButtons(alertKey, firingEventId) }];
}

function actionButtons(alertKey: string, firingEventId: string | null): Record<string, unknown>[] {
  return [
    button("Non actionable", "IGNORE_IT", alertKey, firingEventId),
    button("In progress", "WORKING_ON_IT", alertKey, firingEventId),
    button("Done", "DONE", alertKey, firingEventId),
  ];
}

export function firingParent(body: Record<string, unknown>): string {
  const lines = [`${firingIcon(severityOf(body))} Monitor FIRING: *${monitorName(body)}*`, "*State:* OK → ALERT"];
  lines.push(...tagLines(body));
  const detail = detailLine(body, "FIRING");
  if (detail) lines.push(`*Detail:* ${detail}`);
  const window = windowLine(body);
  if (window) lines.push(`*Window:* ${window}`);
  const manual = manualOf(body);
  if (manual) lines.push(`*URL:* ${manual}`);
  return lines.join("\n");
}

export function resolvedParent(firing: Record<string, unknown>, resolved: Record<string, unknown>): string {
  const lines = [`✅ Monitor RESOLVED: *${monitorName(firing)}*`, "*State:* ALERT → OK"];
  lines.push(...tagLines(firing));
  const detail = detailLine(firing, "FIRING");
  if (detail) lines.push(`*Detail:* ${detail}`);
  const window = windowLine(firing);
  if (window) lines.push(`*Window:* ${window}`);
  const resolvedAt = typeof resolved.resolved_at === "string" ? resolved.resolved_at : "";
  const firedAt = typeof firing.fired_at === "string" ? firing.fired_at : "";
  if (resolvedAt) lines.push(`*Resolved:* ${resolvedAt} (duration ${duration(firedAt, resolvedAt)})`);
  const manual = manualOf(firing) ?? manualOf(resolved);
  if (manual) lines.push(`*URL:* ${manual}`);
  return lines.join("\n");
}

export function recoveryReply(firing: Record<string, unknown>, resolved: Record<string, unknown>): string {
  const resolvedAt = typeof resolved.resolved_at === "string" ? resolved.resolved_at : "";
  const firedAt = typeof firing.fired_at === "string" ? firing.fired_at : "";
  const lines = ["✅ Resolved", `Recovered at: ${resolvedAt}`, `Duration: ${duration(firedAt, resolvedAt)}`];
  const finalValue = finalValueLine(resolved);
  if (finalValue) lines.push(`Final value: ${finalValue}`);
  return lines.join("\n");
}

/** Thread note for an open-episode severity change (plan 006 §2). Icon matches the new severity. */
export function severityChangeReply(previousSeverity: string | null, nextSeverity: string | null): string {
  const from = previousSeverity && previousSeverity.length > 0 ? previousSeverity : "none";
  const to = nextSeverity && nextSeverity.length > 0 ? nextSeverity : "none";
  return `${firingIcon(nextSeverity)} severity: ${from} → ${to}`;
}

export async function deliverSlack(log: AlertLog, body: Record<string, unknown>, sender: SlackSender, channel: string): Promise<void> {
  const alertKey = body.alert_key;
  if (typeof alertKey !== "string" || alertKey.length === 0) return;
  if (body.transition === "FIRING") {
    if (body.severity !== "critical" && body.severity !== "warning" && body.severity !== "info") return;
    const arrival = classifyFiringArrival(log.list(), alertKey, eventIdOf(body), severityOf(body));
    if (arrival.kind === "repeat") return;
    if (arrival.kind === "severity_update") {
      await deliverSeverityUpdate(log, body, sender, channel, arrival.previousSeverity, arrival.openingEventId);
      return;
    }
    // Idempotent re-delivery of the same opening FIRING (parent already stored).
    if (findParent(log, alertKey, eventIdOf(body))) return;
    const posted = await sender.postMessage({ channel, text: firingParent(body) });
    let solicitTs: string | null = null;
    if (body.severity === "critical") {
      try {
        const reply = await sender.postMessage({
          channel,
          text: solicitText(),
          threadTs: posted.ts,
          blocks: solicitBlocks(alertKey, eventIdOf(body)),
        });
        solicitTs = reply.ts;
      } catch (error) {
        console.error(error);
      }
    }
    saveParent(log, alertKey, {
      alert_key: alertKey,
      channel,
      ts: posted.ts,
      solicit_ts: solicitTs,
      firing_event_id: eventIdOf(body),
    });
    return;
  }
  if (body.transition !== "RESOLVED") return;
  const stored = latestParent(log, alertKey);
  if (!stored) return;
  const parent = parseParent(stored.body);
  if (!parent || parent.ts.length === 0) return;
  const firing = firingBody(log, alertKey, eventIdOf(body)) ?? body;
  const text = resolvedParent(firing, body);
  try {
    await sender.update({ channel: parent.channel, ts: parent.ts, text });
  } catch {
    await sender.postMessage({ channel: parent.channel, text });
  }
  await sender.postMessage({ channel: parent.channel, text: recoveryReply(firing, body), threadTs: parent.ts });
}

async function deliverSeverityUpdate(
  log: AlertLog,
  body: Record<string, unknown>,
  sender: SlackSender,
  channel: string,
  previousSeverity: string | null,
  openingEventId: string,
): Promise<void> {
  const alertKey = body.alert_key;
  if (typeof alertKey !== "string") return;
  const stored = findParent(log, alertKey, openingEventId) ?? latestParent(log, alertKey);
  if (!stored) return;
  const parent = parseParent(stored.body);
  if (!parent || parent.ts.length === 0) return;

  const nextSeverity = severityOf(body);
  const text = firingParent(body);
  try {
    await sender.update({ channel: parent.channel, ts: parent.ts, text });
  } catch (error) {
    console.error(error);
  }
  const postChannel = parent.channel.length > 0 ? parent.channel : channel;
  await sender.postMessage({
    channel: postChannel,
    text: severityChangeReply(previousSeverity, nextSeverity),
    threadTs: parent.ts,
  });

  const becomingCritical = nextSeverity === "critical" && previousSeverity !== "critical";
  let solicitTs = parent.solicit_ts;
  if (becomingCritical) {
    const prior = attentionBeforeUpdate(log, alertKey, openingEventId, eventIdOf(body));
    // §3 first critical; §4 reconsider only when last close was Done. Owned/ignored: no new solicit.
    const firstCritical = !parent.solicit_ts;
    const reconsiderDone = Boolean(parent.solicit_ts) && prior.done;
    if (firstCritical || reconsiderDone) {
      try {
        const reply = await sender.postMessage({
          channel: postChannel,
          text: firstCritical ? solicitText() : reconsiderSolicitText(),
          threadTs: parent.ts,
          blocks: solicitBlocks(alertKey, openingEventId),
        });
        solicitTs = reply.ts;
      } catch (error) {
        console.error(error);
      }
    }
  }

  saveParent(log, alertKey, {
    alert_key: alertKey,
    channel: postChannel,
    ts: parent.ts,
    solicit_ts: solicitTs,
    firing_event_id: parent.firing_event_id.length > 0 ? parent.firing_event_id : openingEventId,
  });
}

/** Human state on the open episode before the current FIRING row (already saved) is applied. */
function attentionBeforeUpdate(
  log: AlertLog,
  alertKey: string,
  openingEventId: string,
  currentEventId: string,
): { done: boolean; attention: string } {
  const priorEvents = log.list().filter((event) => {
    if (event.eventId === currentEventId) return false;
    try {
      const body = JSON.parse(event.body) as { event_id?: unknown };
      if (body.event_id === currentEventId) return false;
    } catch {
      return true;
    }
    return true;
  });
  const episode = projectThreads(priorEvents).find(
    (thread) => thread.alertKey === alertKey && thread.firingEventId === openingEventId,
  );
  if (!episode) return { done: false, attention: "recorded" };
  return { done: episode.done !== null, attention: episode.attention };
}

export function liveSlack(token: string): SlackSender {
  return {
    async postMessage(input) {
      const payload = await call(token, "chat.postMessage", {
        channel: input.channel,
        text: input.text,
        thread_ts: input.threadTs,
        blocks: input.blocks,
      });
      if (typeof payload.ts !== "string") throw new Error("Slack chat.postMessage returned no ts");
      return { ts: payload.ts };
    },
    async update(input) {
      await call(token, "chat.update", {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
        blocks: input.blocks,
      });
    },
  };
}

function button(label: string, action: string, alertKey: string, firingEventId: string | null): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    action_id: action,
    value: encodedButtonValue(alertKey, firingEventId),
  };
}

function encodedButtonValue(alertKey: string, firingEventId: string | null): string {
  if (!firingEventId) return alertKey;
  return JSON.stringify({ alert_key: alertKey, firing_event_id: firingEventId });
}

function buttonValue(value: string): { alertKey: string; firingEventId: string | null } | null {
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { alert_key?: unknown; firing_event_id?: unknown };
      if (typeof parsed.alert_key !== "string" || parsed.alert_key.length === 0) return null;
      const firingEventId = typeof parsed.firing_event_id === "string" && parsed.firing_event_id.length > 0 ? parsed.firing_event_id : null;
      return { alertKey: parsed.alert_key, firingEventId };
    } catch {
      return null;
    }
  }
  return value.length > 0 ? { alertKey: value, firingEventId: null } : null;
}

function threadTsOf(payload: object): string | null {
  const record = payload as { message?: unknown; container?: unknown };
  const message = objectOf(record.message);
  const container = objectOf(record.container);
  if (typeof message?.thread_ts === "string" && message.thread_ts.length > 0) return message.thread_ts;
  if (typeof container?.thread_ts === "string" && container.thread_ts.length > 0) return container.thread_ts;
  return null;
}

function firingIcon(severity: string | null): string {
  if (severity === "critical") return "🚨 *CRITICAL*";
  if (severity === "warning") return "⚠️ *WARNING*";
  if (severity === "info") return "ℹ️ *INFO*";
  return ":rotating_light:";
}

function severityOf(body: Record<string, unknown>): string | null {
  return typeof body.severity === "string" && body.severity.length > 0 ? body.severity : null;
}

function monitorName(body: Record<string, unknown>): string {
  if (typeof body.monitor_name === "string" && body.monitor_name.length > 0) return body.monitor_name;
  const details = objectOf(body.details);
  if (typeof details?.monitor_name === "string" && details.monitor_name.length > 0) return details.monitor_name;
  return "Monitor";
}

/** Slack lines for identity (join key) then condition (mutable). Falls back to all tags as Identity. */
function tagLines(body: Record<string, unknown>): string[] {
  const all = objectOf(body.time_series_tags) ?? objectOf(body.labels);
  const identity = objectOf(body.identity_tags);
  const details = objectOf(body.details);
  const conditionKeys = stringList(details?.condition_tag_keys);

  if (identity || conditionKeys.length > 0) {
    const identityMap = identity ?? pickTags(all, (key) => !conditionKeys.includes(key));
    const conditionMap = pickTags(all, (key) => conditionKeys.includes(key));
    const lines: string[] = [];
    const identityText = formatTags(identityMap);
    if (identityText) lines.push(`*Identity:* ${identityText}`);
    const conditionText = formatTags(conditionMap);
    if (conditionText) lines.push(`*Condition:* ${conditionText}`);
    return lines;
  }

  const fallback = formatTags(all);
  return fallback ? [`*Identity:* ${fallback}`] : [];
}

function pickTags(
  tags: Record<string, unknown> | null,
  keep: (key: string) => boolean,
): Record<string, unknown> | null {
  if (!tags) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(tags)) {
    if (keep(key) && typeof tags[key] === "string") out[key] = tags[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function formatTags(tags: Record<string, unknown> | null): string {
  if (!tags) return "";
  return Object.keys(tags)
    .filter((key) => typeof tags[key] === "string")
    .sort()
    .map((key) => `${key}=${tags[key] as string}`)
    .join(", ");
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function detailLine(body: Record<string, unknown>, transition: "FIRING" | "RESOLVED"): string {
  const details = objectOf(body.details);
  const metric = details && typeof details.metric_name === "string" ? details.metric_name : "";
  const threshold = details ? asNumber(details.threshold) : null;
  const points = details ? asNumber(details.consecutive_points) : null;
  const value = details ? asNumber(details.value) : null;
  if (metric && threshold !== null && points !== null && value !== null) {
    const label = points === 1 ? "point" : "points";
    const matched = transition === "FIRING" ? "matched" : "no longer matched";
    return `value ${value} ${matched} GTE threshold ${threshold} for ${points} consecutive ${label} for metric ${metric}`;
  }
  return typeof body.summary === "string" ? body.summary : "";
}

function windowLine(body: Record<string, unknown>): string | null {
  const details = objectOf(body.details);
  if (!details || typeof details.window_start !== "string" || typeof details.window_end !== "string") return null;
  return `${details.window_start} – ${details.window_end}`;
}

function manualOf(body: Record<string, unknown>): string | null {
  return typeof body.manual_url === "string" && body.manual_url.length > 0 ? body.manual_url : null;
}

function finalValueLine(body: Record<string, unknown>): string | null {
  const details = objectOf(body.details);
  if (!details) return null;
  const value = asNumber(details.value);
  const threshold = asNumber(details.threshold);
  if (value === null || threshold === null) return null;
  return `${value} (threshold ${threshold})`;
}

function duration(firedAt: string, resolvedAt: string): string {
  const ms = Math.max(0, Date.parse(resolvedAt) - Date.parse(firedAt));
  const total = Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function eventIdOf(body: Record<string, unknown>): string {
  return typeof body.event_id === "string" ? body.event_id : "";
}

function saveParent(log: AlertLog, alertKey: string, parent: SlackParent): void {
  const id = slackEventId(alertKey, parent.firing_event_id);
  const body = JSON.stringify(parent);
  const receivedAt = new Date().toISOString();
  if (log.save(id, body, receivedAt) === "duplicate") log.replace(id, body, receivedAt);
}

function parentByThreadTs(log: AlertLog, threadTs: string): SlackParent | null {
  for (const event of log.list()) {
    if (!event.eventId.startsWith("slack:")) continue;
    const parent = parseParent(event.body);
    if (parent?.ts === threadTs) return parent;
  }
  return null;
}

function latestParent(log: AlertLog, alertKey: string): { body: string } | null {
  let found: { body: string } | null = null;
  for (const event of log.list()) {
    if (!event.eventId.startsWith("slack:")) continue;
    const parent = parseParent(event.body);
    if (parent?.alert_key === alertKey) found = event;
  }
  return found;
}

function findParent(log: AlertLog, alertKey: string, firingEventId: string): { body: string } | null {
  if (firingEventId.length === 0) return null;
  const direct = log.get(slackEventId(alertKey, firingEventId));
  if (direct) return direct;
  for (const event of log.list()) {
    if (!event.eventId.startsWith("slack:")) continue;
    const parent = parseParent(event.body);
    if (parent?.alert_key === alertKey && parent.firing_event_id === firingEventId) return event;
  }
  return null;
}

function parseParent(body: string): SlackParent | null {
  const parsed = JSON.parse(body) as Partial<SlackParent>;
  if (typeof parsed.alert_key !== "string" || typeof parsed.ts !== "string" || typeof parsed.firing_event_id !== "string") return null;
  return {
    alert_key: parsed.alert_key,
    channel: typeof parsed.channel === "string" ? parsed.channel : "",
    ts: parsed.ts,
    solicit_ts: typeof parsed.solicit_ts === "string" && parsed.solicit_ts.length > 0 ? parsed.solicit_ts : null,
    firing_event_id: parsed.firing_event_id,
  };
}

function firingBody(log: AlertLog, alertKey: string, currentEventId: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const event of log.list()) {
    if (event.eventId === currentEventId) break;
    if (isMeta(event.eventId)) continue;
    const body = JSON.parse(event.body) as Record<string, unknown>;
    if (body.event_id === currentEventId) break;
    if (body.alert_key === alertKey && body.transition === "FIRING") found = body;
  }
  return found;
}

function isMeta(eventId: string): boolean {
  return eventId.startsWith("response:") || eventId.startsWith("escalation:") || eventId.startsWith("done:") || eventId.startsWith("slack:") || eventId.startsWith("shift:") || eventId.startsWith("reply:");
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function displayNameOf(user: unknown): string | null {
  const record = objectOf(user);
  if (!record) return null;
  const profile = objectOf(record.profile);
  if (typeof profile?.display_name === "string" && profile.display_name.trim().length > 0) return profile.display_name.trim();
  if (typeof record.name === "string" && record.name.trim().length > 0) return record.name.trim();
  if (typeof record.real_name === "string" && record.real_name.trim().length > 0) return record.real_name.trim();
  if (typeof profile?.real_name === "string" && profile.real_name.trim().length > 0) return profile.real_name.trim();
  return null;
}

async function call(
  token: string,
  method: string,
  body: Record<string, unknown>,
  encoding: "json" | "form" = "json",
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payloadBody: string;
  if (encoding === "form") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    payloadBody = params.toString();
  } else {
    headers["content-type"] = "application/json";
    payloadBody = JSON.stringify(body);
  }
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers,
    body: payloadBody,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (payload.ok !== true) throw new Error(`Slack ${method} failed: ${typeof payload.error === "string" ? payload.error : response.status}`);
  return payload;
}
