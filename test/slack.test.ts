import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { openLog } from "../src/log.ts";
import { createIntakeServer } from "../src/server.ts";
import { projectThreads } from "../src/thread.ts";
import { applyHumanResponse } from "../src/response.ts";
import {
  clickEpisode,
  deliverSlack,
  firingParent,
  recordReply,
  recoveryReply,
  replyEventId,
  resolvedParent,
  reconsiderSolicitText,
  severityChangeReply,
  showClick,
  slackButton,
  slackChallenge,
  slackConfig,
  slackEventId,
  slackReply,
  solicitText,
  verifySlackSignature,
  type SlackPost,
  type SlackSender,
} from "../src/slack.ts";

const KEY = "mon-dc-building:job-room-01:2c874b5443891358";

describe("slack messages", () => {
  it("posts a firing parent and, for a critical alert, a thread reply", async () => {
    const firing = sample("docs/alert-samples/03.1-critical-firing.json");
    const log = openLog(":memory:");
    const sent = recorder();

    await deliverSlack(log, firing, sent.sender, "C0");

    expect(sent.posts.map((post) => post.threadTs ?? null)).toEqual([null, "1.1"]);
    expect(sent.posts[0]?.text).toContain("🚨 *CRITICAL* Monitor FIRING: *Data Center Building Monitor*");
    expect(sent.posts[0]?.text).toContain("*State:* OK → ALERT");
    expect(sent.posts[0]?.text).toContain("*Identity:* asset_id=ROOM-01, hall_id=HALL-01");
    expect(sent.posts[0]?.text).toContain("*Condition:* alarm_severity=critical");
    expect(sent.posts[0]?.text).not.toContain("*Series:*");
    expect(sent.posts[0]?.text).toContain("*Window:* 2026-11-14T22:56:00.000Z – 2026-11-14T23:01:00.000Z");
    expect(sent.posts[1]?.text).toBe(solicitText());
    expect(JSON.stringify(sent.posts[1]?.blocks)).toContain("WORKING_ON_IT");
    expect(log.get(slackEventId(KEY, String(firing.event_id)))?.body).toContain("\"ts\":\"1.1\"");
    expect(JSON.stringify(sent.posts[1]?.blocks)).toContain(String(firing.event_id));
    log.close();
  });

  it("posts a warning parent and does not ask for a button", async () => {
    const firing = sample("docs/alert-samples/01.1-warning-firing.json");
    const log = openLog(":memory:");
    const sent = recorder();

    await deliverSlack(log, firing, sent.sender, "C0");

    expect(sent.posts).toHaveLength(1);
    expect(sent.posts[0]?.text).toContain("⚠️ *WARNING* Monitor FIRING:");
    expect(sent.posts[0]?.text).toContain("*Identity:* asset_id=ROOM-01, hall_id=HALL-01");
    expect(sent.posts[0]?.text).toContain("*Condition:* alarm_severity=warning");
    expect(sent.posts[0]?.blocks).toBeUndefined();
    log.close();
  });

  it("falls back to Identity only when C3 has no identity/condition split", () => {
    const firing = sample("docs/alert-samples/05-service-firing.json");
    const text = firingParent(firing);
    expect(text).toContain("*Identity:* check=error_rate, service=checkout");
    expect(text).not.toContain("*Condition:*");
    expect(text).not.toContain("*Series:*");
  });

  it("edits the parent on resolve and adds the recovery reply", async () => {
    const firing = sample("docs/alert-samples/03.1-critical-firing.json");
    const resolved = sample("docs/alert-samples/04.1-critical-resolved.json");
    const log = openLog(":memory:");
    const sent = recorder();
    log.save("firing", JSON.stringify(firing), "2026-11-15T18:00:00.000Z");
    await deliverSlack(log, firing, sent.sender, "C0");
    log.save("resolved", JSON.stringify(resolved), "2026-11-15T18:20:00.000Z");
    await deliverSlack(log, resolved, sent.sender, "C0");

    expect(sent.updates).toHaveLength(1);
    expect(sent.updates[0]?.text).toContain("✅ Monitor RESOLVED: *Data Center Building Monitor*");
    expect(sent.updates[0]?.text).toContain("*Window:* 2026-11-14T22:56:00.000Z – 2026-11-14T23:01:00.000Z");
    expect(sent.updates[0]?.text).toContain("duration 19m");
    expect(sent.updates[0]?.text).toContain("value 2 matched");
    const recovery = sent.posts.at(-1);
    expect(recovery?.threadTs).toBe("1.1");
    expect(recovery?.text).toBe(recoveryReply(firing, resolved));
    expect(recovery?.text).toContain("Final value: 0 (threshold 1)");
    log.close();
  });

  it("posts a new parent after a resolve, and stays quiet while that firing is still open", async () => {
    const warning = sample("docs/alert-samples/01.1-warning-firing.json");
    const warningKey = String(warning.alert_key);
    const resolved = sample("docs/alert-samples/02.1-warning-resolved.json");
    const log = openLog(":memory:");
    const sent = recorder();
    log.save("r", JSON.stringify(resolved), "2026-11-15T18:00:00.000Z");
    log.save(String(warning.event_id), JSON.stringify(warning), "2026-11-15T18:05:00.000Z");
    await deliverSlack(log, warning, sent.sender, "C0");
    await deliverSlack(log, warning, sent.sender, "C0");

    expect(sent.posts).toHaveLength(1);
    expect(sent.posts[0]?.text).toContain("⚠️ *WARNING* Monitor FIRING:");
    expect(sent.posts[0]?.blocks).toBeUndefined();
    expect(log.get(slackEventId(warningKey, String(warning.event_id)))?.body).toContain("\"ts\":\"1.1\"");

    const again = { ...warning, event_id: "33333333-3333-4333-8333-333333333333" };
    log.save("cleared", JSON.stringify(resolved), "2026-11-15T18:10:00.000Z");
    await deliverSlack(log, resolved, sent.sender, "C0");
    log.save(String(again.event_id), JSON.stringify(again), "2026-11-15T18:15:00.000Z");
    await deliverSlack(log, again, sent.sender, "C0");

    expect(sent.posts).toHaveLength(3);
    expect(sent.posts[2]?.threadTs ?? null).toBeNull();
    expect(log.get(slackEventId(warningKey, String(warning.event_id)))?.body).toContain("\"ts\":\"1.1\"");
    expect(log.get(slackEventId(warningKey, String(again.event_id)))?.body).toContain("\"ts\":\"1.3\"");
    log.close();
  });

  it("edits the parent and threads a severity line on warning → critical", async () => {
    const warning = sample("docs/alert-samples/01.1-warning-firing.json");
    const warningKey = String(warning.alert_key);
    const critical = {
      ...warning,
      event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      severity: "critical",
      labels: { ...(warning.labels as Record<string, string> | undefined), alarm_severity: "critical" },
    };
    const log = openLog(":memory:");
    const sent = recorder();
    log.save(String(warning.event_id), JSON.stringify(warning), "2026-11-18T18:00:00.000Z");
    await deliverSlack(log, warning, sent.sender, "C0");
    log.save(String(critical.event_id), JSON.stringify(critical), "2026-11-18T18:05:00.000Z");
    await deliverSlack(log, critical, sent.sender, "C0");

    expect(sent.posts.filter((post) => post.threadTs == null)).toHaveLength(1);
    expect(sent.updates).toHaveLength(1);
    expect(sent.updates[0]?.ts).toBe("1.1");
    expect(sent.updates[0]?.text).toContain("🚨 *CRITICAL* Monitor FIRING:");
    const threaded = sent.posts.filter((post) => post.threadTs === "1.1");
    expect(threaded.map((post) => post.text)).toEqual([
      severityChangeReply("warning", "critical"),
      solicitText(),
    ]);
    expect(JSON.stringify(threaded[1]?.blocks)).toContain(String(warning.event_id));
    expect(JSON.stringify(threaded[1]?.blocks)).toContain("WORKING_ON_IT");
    const parentMeta = log.get(slackEventId(warningKey, String(warning.event_id)))?.body ?? "";
    expect(parentMeta).toContain("\"firing_event_id\":\"" + String(warning.event_id));
    expect(parentMeta).toContain("\"solicit_ts\"");
    expect(projectThreads(log.list()).find((thread) => thread.alertKey === warningKey)).toMatchObject({
      firingEventId: String(warning.event_id),
      attention: "open",
      severity: "critical",
    });
    log.close();
  });

  it("threads a severity line on critical → warning without a new parent or second solicit", async () => {
    const critical = sample("docs/alert-samples/03.1-critical-firing.json");
    const warning = {
      ...critical,
      event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      severity: "warning",
      labels: { ...(critical.labels as Record<string, string> | undefined), alarm_severity: "warning" },
    };
    const log = openLog(":memory:");
    const sent = recorder();
    log.save(String(critical.event_id), JSON.stringify(critical), "2026-11-18T18:00:00.000Z");
    await deliverSlack(log, critical, sent.sender, "C0");
    const topLevel = sent.posts.filter((post) => post.threadTs == null).length;
    const solicits = sent.posts.filter((post) => post.blocks != null).length;
    log.save(String(warning.event_id), JSON.stringify(warning), "2026-11-18T18:05:00.000Z");
    await deliverSlack(log, warning, sent.sender, "C0");

    expect(sent.posts.filter((post) => post.threadTs == null)).toHaveLength(topLevel);
    expect(sent.updates.at(-1)?.text).toContain("⚠️ *WARNING* Monitor FIRING:");
    expect(sent.posts.at(-1)?.text).toBe(severityChangeReply("critical", "warning"));
    expect(sent.posts.filter((post) => post.blocks != null)).toHaveLength(solicits);
    log.close();
  });

  it("does not solicit again when severity returns to critical after a drop with no Done", async () => {
    const warning = sample("docs/alert-samples/01.1-warning-firing.json");
    const toCritical = {
      ...warning,
      event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      severity: "critical",
    };
    const toWarning = {
      ...warning,
      event_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      severity: "warning",
    };
    const againCritical = {
      ...warning,
      event_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      severity: "critical",
    };
    const log = openLog(":memory:");
    const sent = recorder();
    log.save(String(warning.event_id), JSON.stringify(warning), "2026-11-18T18:00:00.000Z");
    await deliverSlack(log, warning, sent.sender, "C0");
    log.save(String(toCritical.event_id), JSON.stringify(toCritical), "2026-11-18T18:01:00.000Z");
    await deliverSlack(log, toCritical, sent.sender, "C0");
    log.save(String(toWarning.event_id), JSON.stringify(toWarning), "2026-11-18T18:02:00.000Z");
    await deliverSlack(log, toWarning, sent.sender, "C0");
    log.save(String(againCritical.event_id), JSON.stringify(againCritical), "2026-11-18T18:03:00.000Z");
    await deliverSlack(log, againCritical, sent.sender, "C0");

    expect(sent.posts.filter((post) => post.blocks != null)).toHaveLength(1);
    expect(sent.posts.filter((post) => post.threadTs == null)).toHaveLength(1);
    expect(sent.posts.at(-1)?.text).toBe(severityChangeReply("warning", "critical"));
    log.close();
  });

  it("reconsiders attention when severity returns to critical after Done", async () => {
    const warning = sample("docs/alert-samples/01.1-warning-firing.json");
    const warningKey = String(warning.alert_key);
    const openingId = String(warning.event_id);
    const toCritical = { ...warning, event_id: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1", severity: "critical" };
    const toWarning = { ...warning, event_id: "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2", severity: "warning" };
    const againCritical = { ...warning, event_id: "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3", severity: "critical" };
    const log = openLog(":memory:");
    const sent = recorder();
    log.save(openingId, JSON.stringify(warning), "2026-11-18T18:00:00.000Z");
    await deliverSlack(log, warning, sent.sender, "C0");
    log.save(String(toCritical.event_id), JSON.stringify(toCritical), "2026-11-18T18:01:00.000Z");
    await deliverSlack(log, toCritical, sent.sender, "C0");
    // Fixed receivedAt so Done sorts before later severity FIRINGs (applyHumanResponse uses wall clock).
    log.save(
      `done:${warningKey}:1`,
      JSON.stringify({ alert_key: warningKey, action: "DONE", note: null, firing_event_id: openingId }),
      "2026-11-18T18:01:30.000Z",
    );
    log.save(String(toWarning.event_id), JSON.stringify(toWarning), "2026-11-18T18:02:00.000Z");
    await deliverSlack(log, toWarning, sent.sender, "C0");
    log.save(String(againCritical.event_id), JSON.stringify(againCritical), "2026-11-18T18:03:00.000Z");
    await deliverSlack(log, againCritical, sent.sender, "C0");

    const solicits = sent.posts.filter((post) => post.blocks != null);
    expect(solicits).toHaveLength(2);
    expect(solicits[0]?.text).toBe(solicitText());
    expect(solicits[1]?.text).toBe(reconsiderSolicitText());
    expect(JSON.stringify(solicits[1]?.blocks)).toContain(openingId);
    expect(projectThreads(log.list()).find((thread) => thread.alertKey === warningKey)).toMatchObject({
      firingEventId: openingId,
      attention: "open",
      done: null,
      severity: "critical",
    });
    log.close();
  });

  it("does not solicit again after In progress when severity returns to critical", async () => {
    const warning = sample("docs/alert-samples/01.1-warning-firing.json");
    const warningKey = String(warning.alert_key);
    const openingId = String(warning.event_id);
    const toCritical = { ...warning, event_id: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", severity: "critical" };
    const toWarning = { ...warning, event_id: "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2", severity: "warning" };
    const againCritical = { ...warning, event_id: "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3", severity: "critical" };
    const log = openLog(":memory:");
    const sent = recorder();
    log.save(openingId, JSON.stringify(warning), "2026-11-18T18:00:00.000Z");
    await deliverSlack(log, warning, sent.sender, "C0");
    log.save(String(toCritical.event_id), JSON.stringify(toCritical), "2026-11-18T18:01:00.000Z");
    await deliverSlack(log, toCritical, sent.sender, "C0");
    log.save(
      `response:${warningKey}`,
      JSON.stringify({ alert_key: warningKey, action: "WORKING_ON_IT", note: null, firing_event_id: openingId }),
      "2026-11-18T18:01:30.000Z",
    );
    log.save(String(toWarning.event_id), JSON.stringify(toWarning), "2026-11-18T18:02:00.000Z");
    await deliverSlack(log, toWarning, sent.sender, "C0");
    log.save(String(againCritical.event_id), JSON.stringify(againCritical), "2026-11-18T18:03:00.000Z");
    await deliverSlack(log, againCritical, sent.sender, "C0");

    expect(sent.posts.filter((post) => post.blocks != null)).toHaveLength(1);
    expect(sent.posts.at(-1)?.text).toBe(severityChangeReply("warning", "critical"));
    expect(projectThreads(log.list()).find((thread) => thread.alertKey === warningKey)).toMatchObject({
      attention: "owned",
      done: null,
      severity: "critical",
    });
    log.close();
  });

  it("does not post when severity is absent", async () => {
    const log = openLog(":memory:");
    const sent = recorder();
    const resolved = sample("docs/alert-samples/04.1-critical-resolved.json");
    const quiet = { ...sample("docs/alert-samples/01.1-warning-firing.json") };
    delete quiet.severity;
    await deliverSlack(log, quiet, sent.sender, "C0");

    expect(sent.posts).toEqual([]);
    expect(slackConfig({})).toBeNull();
    expect(firingParent(quiet)).toContain(":rotating_light:");
    expect(resolvedParent(sample("docs/alert-samples/03.1-critical-firing.json"), resolved)).toContain("duration 19m");
    log.close();
  });
});

describe("slack button", () => {
  it("records Working on it and then Done from the button payload", async () => {
    const log = openLog(":memory:");
    const server = createIntakeServer(log);
    const base = await listen(server);
    const firing = readFileSync("docs/alert-samples/03.1-critical-firing.json", "utf8");
    const eventId = JSON.parse(firing).event_id as string;
    await fetch(`${base}/v1/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-p8-event-id": eventId },
      body: firing,
    });

    const working = await postButton(base, KEY, "WORKING_ON_IT", "ada");
    expect(working.status).toBe(200);
    const workingBody = (await working.json()) as { text: string; blocks: unknown[] };
    expect(workingBody.text).toBe("State: `In progress`");
    expect(JSON.stringify(workingBody.blocks)).toContain("In progress");
    expect(JSON.stringify(workingBody.blocks)).toContain("Non actionable");
    expect(JSON.stringify(workingBody.blocks)).toContain("Done");
    expect(projectThreads(log.list()).find((thread) => thread.alertKey === KEY)?.attention).toBe("owned");

    const ignored = await postButton(base, KEY, "IGNORE_IT", "bea");
    expect(ignored.status).toBe(200);
    expect(((await ignored.json()) as { text: string }).text).toBe("State: `Non actionable`");
    expect(projectThreads(log.list()).find((thread) => thread.alertKey === KEY)?.attention).toBe("ignored");

    const done = await postButton(base, KEY, "DONE", "ada");
    expect(done.status).toBe(200);
    expect(((await done.json()) as { text: string }).text).toBe("State: `Done`");
    expect(projectThreads(log.list()).find((thread) => thread.alertKey === KEY)?.done).toEqual({ note: null });

    await close(server);
    log.close();
  });

  it("binds a button click to the thread it was pressed in", async () => {
    const firing = sample("docs/alert-samples/03.1-critical-firing.json");
    const resolved = sample("docs/alert-samples/04.1-critical-resolved.json");
    const firstId = String(firing.event_id);
    const secondId = "44444444-4444-4444-8444-444444444444";
    const log = openLog(":memory:");
    const sent = recorder();
    log.save(firstId, JSON.stringify(firing), "2026-11-16T14:18:00.000Z");
    await deliverSlack(log, firing, sent.sender, "C0");
    log.save("resolved", JSON.stringify(resolved), "2026-11-16T14:34:00.000Z");
    await deliverSlack(log, resolved, sent.sender, "C0");
    const again = { ...firing, event_id: secondId };
    log.save(secondId, JSON.stringify(again), "2026-11-16T14:35:00.000Z");
    await deliverSlack(log, again, sent.sender, "C0");

    const payload = {
      message: { thread_ts: "1.1" },
      actions: [{ action_id: "DONE", value: JSON.stringify({ alert_key: KEY, firing_event_id: secondId }) }],
    };
    const action = slackButton(payload);
    expect(action?.threadTs).toBe("1.1");
    const target = clickEpisode(log, action!);
    expect(target).toEqual({ alertKey: KEY, firingEventId: firstId });

    const saved = applyHumanResponse(log, {
      alertKey: target.alertKey,
      action: "DONE",
      note: null,
      actor: "ada",
      firingEventId: target.firingEventId,
    });
    expect(saved.status).toBe(202);
    const threads = projectThreads(log.list()).filter((thread) => thread.alertKey === KEY);
    expect(threads.find((thread) => thread.firingEventId === firstId)?.done).toEqual({ note: null });
    expect(threads.find((thread) => thread.firingEventId === secondId)?.done).toBeNull();

    await showClick(log, sent.sender, "C0", KEY, firstId, "State: `Done`", "`Done` ada", true);
    expect(sent.updates.at(-1)?.ts).toBe("1.2");
    expect(sent.posts.at(-1)?.threadTs).toBe("1.1");
    log.close();
  });

  it("stores a thread reply on that firing and ignores the bot and an unknown thread", async () => {
    const log = openLog(":memory:");
    const lookups: string[] = [];
    const server = createIntakeServer(log, {
      resolveUser: async (userId) => {
        lookups.push(userId);
        return userId === "U1" ? "bao" : null;
      },
    });
    const base = await listen(server);
    const firingId = "22222222-2222-4222-8222-222222222211";
    log.save(
      slackEventId(KEY, firingId),
      JSON.stringify({ alert_key: KEY, channel: "C0", ts: "1.1", solicit_ts: "1.2", firing_event_id: firingId }),
      "2026-11-16T16:19:00.000Z",
    );
    log.save(
      firingId,
      JSON.stringify({ event_id: firingId, alert_key: KEY, transition: "FIRING", severity: "critical" }),
      "2026-11-16T16:19:00.000Z",
    );

    const challenge = await postEvent(base, { type: "url_verification", challenge: "abc" });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "abc" });
    expect(slackChallenge({ type: "url_verification", challenge: "abc" })).toBe("abc");

    const human = messageEvent({ user: "U1", text: "  cleared the filter  ", ts: "2.2", thread_ts: "1.1" });
    expect((await postEvent(base, human)).status).toBe(200);
    expect((await postEvent(base, human)).status).toBe(200);
    expect(slackReply(botMessage())).toBeNull();
    expect((await postEvent(base, botMessage())).status).toBe(200);
    expect((await postEvent(base, messageEvent({ user: "U1", text: "elsewhere", ts: "3.3", thread_ts: "9.9" }))).status).toBe(200);

    const stored = log.get(replyEventId("C0", "2.2"));
    expect(JSON.parse(stored?.body ?? "{}")).toMatchObject({
      alert_key: KEY,
      firing_event_id: firingId,
      text: "cleared the filter",
      actor: "bao",
      actor_id: "U1",
    });
    expect(lookups[0]).toBe("U1");
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    expect(log.list().filter((event) => event.eventId.startsWith("reply:"))).toHaveLength(1);
    const thread = projectThreads(log.list()).find((item) => item.firingEventId === firingId);
    expect(thread?.eventIds).toContain(replyEventId("C0", "2.2"));
    expect(thread?.attention).toBe("open");
    expect(recordReply(log, { channel: "C0", ts: "2.2", threadTs: "1.1", text: "again", actor: "bao", actorId: "U1" })).toBe("duplicate");

    await close(server);
    log.close();
  });

  it("answers Slack's certificate check", async () => {
    const log = openLog(":memory:");
    const server = createIntakeServer(log);
    const base = await listen(server);
    const response = await fetch(`${base}/slack/interactions`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "ssl_check=1&token=check",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await close(server);
    log.close();
  });

  it("rejects a signed request whose signature does not match", () => {
    const raw = "payload=%7B%7D";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:${raw}`).digest("hex")}`;
    expect(verifySlackSignature(raw, timestamp, signature, "secret")).toBe(true);
    expect(verifySlackSignature(raw, timestamp, signature, "other")).toBe(false);
  });
});

function postEvent(base: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/slack/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function messageEvent(event: { user: string; text: string; ts: string; thread_ts: string }): unknown {
  return { type: "event_callback", event: { type: "message", channel: "C0", ...event } };
}

function botMessage(): unknown {
  return {
    type: "event_callback",
    event: { type: "message", subtype: "bot_message", bot_id: "B1", channel: "C0", text: "State: `Done`", ts: "4.4", thread_ts: "1.1" },
  };
}

function postButton(base: string, alertKey: string, action: string, username = "ada"): Promise<Response> {
  const payload = JSON.stringify({ user: { username }, actions: [{ action_id: action, value: alertKey }] });
  return fetch(`${base}/slack/interactions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ payload }).toString(),
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sample(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function recorder(): { sender: SlackSender; posts: SlackPost[]; updates: Array<{ ts: string; text: string }> } {
  const posts: SlackPost[] = [];
  const updates: Array<{ ts: string; text: string }> = [];
  let n = 0;
  return {
    posts,
    updates,
    sender: {
      async postMessage(input) {
        posts.push(input);
        n += 1;
        return { ts: `1.${n}` };
      },
      async update(input) {
        updates.push({ ts: input.ts, text: input.text });
      },
    },
  };
}
