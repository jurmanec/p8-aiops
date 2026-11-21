import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { openLog, type AlertLog } from "../src/log.ts";
import { createIntakeServer } from "../src/server.ts";
import { projectThreads, responseEventId, type Thread } from "../src/thread.ts";

describe("message text", () => {
  it("says when the critical alert has no manual link", () => {
    const threads = projectThreads([
      {
        eventId: "c",
        receivedAt: "2026-11-15T14:00:00.000Z",
        body: JSON.stringify({
          event_id: "c",
          alert_key: "crit-key",
          transition: "FIRING",
          severity: "critical",
          manual_url: "",
          summary: "pump fault",
        }),
      },
    ]);
    expect(find(threads, "crit-key").message).toBe(
      "Critical alert is firing.\npump fault\nNo manual link.\nPress a button. Keep follow-up notes, including the note that closes the loop, on this message.",
    );
  });
});

describe("human response", () => {
  let log: AlertLog;
  let server: Server;
  let base: string;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    log.close();
  });

  it("offers a message only for an open critical thread", async () => {
    await start();
    await postAlert("docs/alert-samples/01.1-warning-firing.json");
    await postAlert("docs/alert-samples/03.1-critical-firing.json");
    await postAlert("docs/alert-samples/05-service-firing.json");

    const threads = await threadsNow();
    expect(find(threads, "mon-dc-building:job-room-01:a0f87b2057b3eb10").message).toBeNull();
    expect(find(threads, "mon-checkout:job-api:9f2c1a0b7e44d618").message).toBeNull();
    expect(find(threads, "mon-dc-building:job-room-01:2c874b5443891358").message).toBe(
      [
        "Critical alert is firing.",
        "row_count 2 ≥ threshold 1 for 1 consecutive point",
        "Manual: https://example.test/runbooks/room-env",
        "Press a button. Keep follow-up notes, including the note that closes the loop, on this message.",
      ].join("\n"),
    );
  });

  it("records WORKING_ON_IT without treating the note as a decision", async () => {
    await start();
    await postAlert("docs/alert-samples/03.1-critical-firing.json");
    const saved = await postResponse({
      alert_key: "mon-dc-building:job-room-01:2c874b5443891358",
      action: "WORKING_ON_IT",
      note: "severity critical means resolved",
    });
    expect(saved.status).toBe(202);

    const thread = find(await threadsNow(), "mon-dc-building:job-room-01:2c874b5443891358");
    expect(thread).toMatchObject({
      attention: "owned",
      condition: "firing",
      contact: "none",
      response: { action: "WORKING_ON_IT", note: "severity critical means resolved" },
    });
    expect(log.get(responseEventId(thread.alertKey))?.eventId).toBe(`response:${thread.alertKey}`);
  });

  it("keeps a repeated click and lets a later click replace it", async () => {
    await start();
    await postAlert("docs/alert-samples/03.1-critical-firing.json");
    const key = "mon-dc-building:job-room-01:2c874b5443891358";
    expect((await postResponse({ alert_key: key, action: "IGNORE_IT", note: "first" })).status).toBe(202);
    expect((await postResponse({ alert_key: key, action: "IGNORE_IT", note: "first" })).status).toBe(200);
    expect((await postResponse({ alert_key: key, action: "IGNORE_IT", note: "second" })).status).toBe(202);
    expect((await postResponse({ alert_key: key, action: "WORKING_ON_IT" })).status).toBe(202);
    expect(find(await threadsNow(), key).response).toEqual({ action: "WORKING_ON_IT", note: null });
    expect(find(await threadsNow(), key).attention).toBe("owned");
  });

  it("stores the first click on a firing that opened after an earlier one recovered", async () => {
    await start();
    const key = "mon-dc-building:job-room-01:2c874b5443891358";
    await postAlert("docs/alert-samples/03.1-critical-firing.json");
    expect((await postResponse({ alert_key: key, action: "WORKING_ON_IT" })).status).toBe(202);
    await postAlert("docs/alert-samples/04.1-critical-resolved.json");
    const again = JSON.parse(readFileSync("docs/alert-samples/03.1-critical-firing.json", "utf8")) as { event_id: string };
    again.event_id = "33333333-3333-4333-8333-333333333333";
    const saved = await fetch(`${base}/v1/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-p8-event-id": again.event_id },
      body: JSON.stringify(again),
    });
    expect(saved.status).toBe(202);
    expect((await postResponse({ alert_key: key, action: "WORKING_ON_IT" })).status).toBe(202);
    expect(log.list().filter((event) => event.eventId.startsWith("response:")).length).toBe(2);
  });

  it("rejects a response for a thread that was not opened", async () => {
    await start();
    await postAlert("docs/alert-samples/01.1-warning-firing.json");
    const warning = await postResponse({
      alert_key: "mon-dc-building:job-room-01:a0f87b2057b3eb10",
      action: "WORKING_ON_IT",
    });
    expect(warning.status).toBe(409);

    const missing = await postResponse({ alert_key: "no-such-thread", action: "IGNORE_IT" });
    expect(missing.status).toBe(404);
    expect(log.list().some((event) => event.eventId.startsWith("response:"))).toBe(false);
  });

  it("stores DONE on the episode named by firing_event_id", async () => {
    await start();
    const key = "mon-dc-building:job-room-01:2c874b5443891358";
    const first = JSON.parse(readFileSync("docs/alert-samples/03.1-critical-firing.json", "utf8")) as { event_id: string };
    await postAlert("docs/alert-samples/03.1-critical-firing.json");
    await postAlert("docs/alert-samples/04.1-critical-resolved.json");
    const again = { ...first, event_id: "33333333-3333-4333-8333-333333333333" };
    const savedAlert = await fetch(`${base}/v1/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-p8-event-id": again.event_id },
      body: JSON.stringify(again),
    });
    expect(savedAlert.status).toBe(202);
    const saved = await postResponse({ alert_key: key, action: "DONE", firing_event_id: first.event_id });
    expect(saved.status).toBe(202);
    const threads = (await threadsNow()).filter((thread) => thread.alertKey === key);
    expect(threads.find((thread) => thread.firingEventId === first.event_id)?.done).toEqual({ note: null });
    expect(threads.find((thread) => thread.firingEventId === again.event_id)?.attention).toBe("open");
  });

  it("still accepts ownership after P2 resolves the condition", async () => {
    await start();
    await postAlert("docs/alert-samples/03.1-critical-firing.json");
    await postAlert("docs/alert-samples/04.1-critical-resolved.json");
    const key = "mon-dc-building:job-room-01:2c874b5443891358";
    expect((await postResponse({ alert_key: key, action: "WORKING_ON_IT" })).status).toBe(202);
    expect(find(await threadsNow(), key)).toMatchObject({
      attention: "owned",
      condition: "cleared",
    });
  });

  it("keeps a later DONE note apart from the ack and from P2 RESOLVED", async () => {
    await start();
    await postAlert("docs/alert-samples/01.1-warning-firing.json");
    expect(
      (await postResponse({ alert_key: "mon-dc-building:job-room-01:a0f87b2057b3eb10", action: "DONE", note: "no" }))
        .status,
    ).toBe(409);

    const key = "mon-dc-building:job-room-01:2c874b5443891358";
    await postAlert("docs/alert-samples/03.1-critical-firing.json");
    expect((await postResponse({ alert_key: key, action: "WORKING_ON_IT", note: "checking the room" })).status).toBe(202);
    expect((await postResponse({ alert_key: key, action: "DONE", note: "loop is closed" })).status).toBe(202);
    expect((await postResponse({ alert_key: key, action: "DONE", note: "loop is closed" })).status).toBe(200);
    expect((await postResponse({ alert_key: key, action: "DONE", note: "loop is closed, pump reset" })).status).toBe(202);

    expect(find(await threadsNow(), key)).toMatchObject({
      attention: "owned",
      condition: "firing",
      response: { action: "WORKING_ON_IT", note: "checking the room" },
      done: { note: "loop is closed, pump reset" },
    });

    await postAlert("docs/alert-samples/04.1-critical-resolved.json");
    expect(find(await threadsNow(), key).condition).toBe("cleared");

    const shift = await fetch(`${base}/v1/shifts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: "2026-01-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" }),
    });
    expect(shift.status).toBe(202);
    const report = (await shift.json()) as { threads: Array<Record<string, unknown>> };
    expect(report.threads.find((thread) => thread.alertKey === key)).toMatchObject({
      answer: "WORKING_ON_IT",
      note: "checking the room",
      doneNote: "loop is closed, pump reset",
      condition: "cleared",
      discrepancy: null,
    });
  });

  async function start(): Promise<void> {
    log = openLog(":memory:");
    server = createIntakeServer(log);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  }

  function postAlert(path: string): Promise<Response> {
    const body = readFileSync(path, "utf8");
    return fetch(`${base}/v1/alerts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-p8-event-id": JSON.parse(body).event_id as string,
      },
      body,
    });
  }

  function postResponse(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function threadsNow(): Promise<Thread[]> {
    const response = await fetch(`${base}/v1/threads`);
    const body = (await response.json()) as { threads: Thread[] };
    return body.threads;
  }
});

function find(threads: Thread[], alertKey: string): Thread {
  const thread = threads.find((item) => item.alertKey === alertKey);
  if (!thread) throw new Error(`missing thread ${alertKey}`);
  return thread;
}
