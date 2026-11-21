import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openLog } from "../src/log.ts";
import { buildShiftReport } from "../src/report.ts";
import { applyHumanResponse } from "../src/response.ts";
import { clickEpisode, deliverSlack, recordReply, slackButton, slackEventId, slackReply, type SlackPost, type SlackSender } from "../src/slack.ts";

const KEY = "mon-dc-building:job-room-01:2c874b5443891358";
const START = "2026-11-16T14:00:00.000Z";

describe("shift journey", () => {
  it("keeps a Done and a typed reply on the older firing after a newer one has opened", async () => {
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
    expect(target).toEqual({ alertKey: KEY, firingEventId: firstId });
    const saved = applyHumanResponse(log, {
      alertKey: target.alertKey,
      action: "DONE",
      note: null,
      actor: "ada",
      firingEventId: target.firingEventId,
    });
    expect(saved.status).toBe(202);

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
    expect(recordReply(log, reply!)).toBe("saved");

    const end = new Date(Date.now() + 60_000).toISOString();
    const report = buildShiftReport(log.list(), START, end);
    const episodes = report.threads.filter((thread) => thread.alertKey === KEY);
    const older = episodes.find((thread) => thread.firingEventId === firstId);
    const newer = episodes.find((thread) => thread.firingEventId === secondId);

    expect(older).toMatchObject({
      condition: "cleared",
      attention: "owned",
      done: true,
      discrepancy: null,
    });
    expect(newer).toMatchObject({
      condition: "firing",
      attention: "open",
      done: false,
      discrepancy: null,
    });
    expect(episodes.filter((thread) => thread.attention === "open")).toHaveLength(1);
    expect(episodes.filter((thread) => thread.condition === "firing")).toHaveLength(1);
    expect(episodes.filter((thread) => thread.discrepancy !== null)).toHaveLength(0);
    expect(report.model).toBeNull();

    const projected = log.list();
    const done = projected.find((event) => event.eventId.startsWith("done:"));
    const note = projected.find((event) => event.eventId.startsWith("reply:"));
    expect(JSON.parse(done?.body ?? "{}")).toMatchObject({ actor: "ada", firing_event_id: firstId, action: "DONE" });
    expect(JSON.parse(note?.body ?? "{}")).toMatchObject({
      actor: "bao",
      firing_event_id: firstId,
      text: "filter was blocked",
    });

    log.close();
  });

  it("clears the discrepancy when Done follows In progress and a resolve", async () => {
    const firing = sample("docs/alert-samples/03.1-critical-firing.json");
    const resolved = sample("docs/alert-samples/04.1-critical-resolved.json");
    const firingId = String(firing.event_id);
    const log = openLog(":memory:");
    const sent = recorder();

    log.save(firingId, JSON.stringify(firing), "2026-11-16T14:18:00.000Z");
    await deliverSlack(log, firing, sent.sender, "C0");
    expect(press(log, firingId, "WORKING_ON_IT", "ada").status).toBe(202);

    log.save(String(resolved.event_id), JSON.stringify(resolved), "2026-11-16T14:34:00.000Z");
    await deliverSlack(log, resolved, sent.sender, "C0");

    const end = new Date(Date.now() + 60_000).toISOString();
    const before = buildShiftReport(log.list(), START, end);
    const openDiscrepancy = before.threads.find((thread) => thread.firingEventId === firingId);
    expect(openDiscrepancy).toMatchObject({
      condition: "cleared",
      attention: "owned",
      done: false,
      discrepancy: "condition cleared, human not done",
    });
    expect(before.threads.filter((thread) => thread.discrepancy !== null)).toHaveLength(1);

    expect(press(log, firingId, "DONE", "ada").status).toBe(202);

    const after = buildShiftReport(log.list(), START, end);
    const closed = after.threads.find((thread) => thread.firingEventId === firingId);
    expect(closed).toMatchObject({
      condition: "cleared",
      attention: "owned",
      done: true,
      discrepancy: null,
    });
    expect(after.threads.filter((thread) => thread.discrepancy !== null)).toHaveLength(0);

    log.close();
  });
});

function press(log: ReturnType<typeof openLog>, firingEventId: string, action: "WORKING_ON_IT" | "DONE", actor: string) {
  const payload = {
    user: { username: actor },
    message: { thread_ts: parentTs(log, firingEventId) },
    actions: [{ action_id: action, value: JSON.stringify({ alert_key: KEY, firing_event_id: firingEventId }) }],
  };
  const click = slackButton(payload);
  const target = clickEpisode(log, click!);
  return applyHumanResponse(log, {
    alertKey: target.alertKey,
    action,
    note: null,
    actor,
    firingEventId: target.firingEventId,
  });
}

function parentTs(log: ReturnType<typeof openLog>, firingEventId: string): string {
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
