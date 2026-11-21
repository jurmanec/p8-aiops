import { readFileSync } from "node:fs";
import { openLog, type AlertLog } from "../../src/log.ts";
import { applyHumanResponse } from "../../src/response.ts";
import {
  clickEpisode,
  deliverSlack,
  recordReply,
  slackButton,
  slackEventId,
  slackReply,
  type SlackPost,
  type SlackSender,
} from "../../src/slack.ts";
import { summaryBrief } from "../../src/summary.ts";

/** Same series and window start as `test/journey.test.ts`. */
export const KEY = "mon-dc-building:job-room-01:2c874b5443891358";
export const START = "2026-11-16T14:00:00.000Z";
/** Fixed end so the golden brief does not drift with wall clock. */
export const END = "2026-11-16T16:00:00.000Z";

/**
 * First journey case: Done and a typed reply stay on the older firing after a newer one opens.
 * Returns an in-memory log ready for `summaryBrief`.
 */
export async function buildOlderDoneNewerFiring(): Promise<AlertLog> {
  const firing = sample("docs/alert-samples/03.1-critical-firing.json");
  const resolved = sample("docs/alert-samples/04.1-critical-resolved.json");
  const firstId = String(firing.event_id);
  const secondId = "44444444-4444-4444-8444-444444444444";
  const log = openLog(":memory:");
  const sent = recorder();

  log.save(firstId, JSON.stringify(firing), "2026-11-16T14:18:00.000Z");
  await deliverSlack(log, firing, sent.sender, "C0");
  log.save(String(resolved.event_id), JSON.stringify(resolved), "2026-11-16T14:34:00.000Z");
  await deliverSlack(log, resolved, sent.sender, "C0");
  const again = { ...firing, event_id: secondId };
  log.save(secondId, JSON.stringify(again), "2026-11-16T14:35:00.000Z");
  await deliverSlack(log, again, sent.sender, "C0");

  const olderThread = parentTs(log, firstId);
  const payload = {
    user: { username: "ada" },
    message: { thread_ts: olderThread },
    actions: [{ action_id: "DONE", value: JSON.stringify({ alert_key: KEY, firing_event_id: secondId }) }],
  };
  const click = slackButton(payload);
  const target = clickEpisode(log, click!);
  applyHumanResponse(log, {
    alertKey: target.alertKey,
    action: "DONE",
    note: null,
    actor: "ada",
    firingEventId: target.firingEventId,
  });

  const reply = slackReply({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C0",
      user: "bao",
      text: "filter was blocked",
      ts: "2.2",
      thread_ts: olderThread,
    },
  });
  recordReply(log, reply!);
  // Done/reply use wall-clock receivedAt; pin them inside the fixed golden window.
  pinHumanEvents(log, "2026-11-16T14:40:00.000Z", "2026-11-16T14:41:00.000Z");
  return log;
}

function pinHumanEvents(log: AlertLog, doneAt: string, replyAt: string): void {
  for (const event of log.list()) {
    if (event.eventId.startsWith("done:")) log.replace(event.eventId, event.body, doneAt);
    if (event.eventId.startsWith("reply:")) log.replace(event.eventId, event.body, replyAt);
  }
}

export async function briefForOlderDoneNewerFiring(): Promise<string> {
  const log = await buildOlderDoneNewerFiring();
  try {
    return summaryBrief(log.list(), START, END);
  } finally {
    log.close();
  }
}

function parentTs(log: AlertLog, firingEventId: string): string {
  const row = log.get(slackEventId(KEY, firingEventId));
  const body = JSON.parse(row?.body ?? "{}") as { ts?: string };
  if (!body.ts) throw new Error("missing parent");
  return body.ts;
}

function sample(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function recorder(): { sender: SlackSender; posts: SlackPost[] } {
  const posts: SlackPost[] = [];
  let n = 0;
  return {
    posts,
    sender: {
      async postMessage(input) {
        posts.push(input);
        n += 1;
        return { ts: `1.${n}` };
      },
      async update() {},
    },
  };
}
