import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { openLog, type AlertLog, type StoredEvent } from "../src/log.ts";
import { createIntakeServer } from "../src/server.ts";
import { classifyFiringArrival, projectThreads, type Thread } from "../src/thread.ts";

describe("thread", () => {
  it("records a warning and leaves a critical alert open", () => {
    const threads = projectThreads([
      firing("w", "warn-key", "warning", "2026-11-15T14:00:00.000Z"),
      firing("c", "crit-key", "critical", "2026-11-15T14:01:00.000Z"),
    ]);
    expect(find(threads, "warn-key")).toMatchObject({
      attention: "recorded",
      condition: "firing",
      contact: "none",
      severity: "warning",
    });
    expect(find(threads, "crit-key")).toMatchObject({
      attention: "open",
      condition: "firing",
      contact: "none",
      severity: "critical",
    });
  });

  it("records an alert with no severity or with info", () => {
    const threads = projectThreads([
      firing("n", "none-key", null, "2026-11-15T14:00:00.000Z"),
      firing("i", "info-key", "info", "2026-11-15T14:01:00.000Z"),
    ]);
    expect(find(threads, "none-key").attention).toBe("recorded");
    expect(find(threads, "info-key").attention).toBe("recorded");
  });

  it("attaches a later resolve without closing ownership of a critical alert", () => {
    const threads = projectThreads([
      firing("c", "crit-key", "critical", "2026-11-15T14:00:00.000Z"),
      resolved("r", "crit-key", "critical", "2026-11-15T14:05:00.000Z"),
    ]);
    expect(find(threads, "crit-key")).toMatchObject({
      attention: "open",
      condition: "cleared",
      contact: "none",
      eventIds: ["c", "r"],
    });
  });

  it("keeps a resolve that arrived first, and opens the later firing as its own episode", () => {
    const threads = projectThreads([
      resolved("r", "crit-key", "critical", "2026-11-15T14:05:00.000Z", {
        fired_at: "2026-11-15T13:00:00.000Z",
      }),
      firing("c", "crit-key", "critical", "2026-11-15T14:06:00.000Z", {
        fired_at: "2026-11-15T13:00:00.000Z",
      }),
    ]);
    expect(threads.filter((thread) => thread.alertKey === "crit-key")).toMatchObject([
      { firingEventId: "c", attention: "open", condition: "firing", eventIds: ["c"] },
      { firingEventId: "r", attention: "recorded", condition: "cleared", eventIds: ["r"] },
    ]);
  });

  it("starts a new episode when a firing follows a resolve", () => {
    const threads = projectThreads([
      firing("c1", "crit-key", "critical", "2026-11-16T14:11:00.000Z"),
      {
        eventId: "response:crit-key",
        receivedAt: "2026-11-16T14:12:00.000Z",
        body: JSON.stringify({ alert_key: "crit-key", action: "WORKING_ON_IT", actor: "jurmanec" }),
      },
      resolved("r", "crit-key", "critical", "2026-11-16T14:14:00.000Z"),
      {
        eventId: "done:crit-key:1",
        receivedAt: "2026-11-16T14:16:00.000Z",
        body: JSON.stringify({ alert_key: "crit-key", action: "DONE" }),
      },
      firing("c2", "crit-key", "critical", "2026-11-16T14:18:00.000Z"),
    ]);
    expect(threads.filter((thread) => thread.alertKey === "crit-key")).toMatchObject([
      {
        firingEventId: "c2",
        attention: "open",
        condition: "firing",
        response: null,
        done: null,
        eventIds: ["c2"],
      },
      {
        firingEventId: "c1",
        attention: "owned",
        condition: "cleared",
        response: { action: "WORKING_ON_IT", note: null },
        done: { note: null },
        eventIds: ["c1", "response:crit-key", "r", "done:crit-key:1"],
      },
    ]);
  });

  it("attaches a click to the firing it names, after a later episode has opened", () => {
    const threads = projectThreads([
      firing("c1", "crit-key", "critical", "2026-11-16T14:18:00.000Z"),
      resolved("r1", "crit-key", "critical", "2026-11-16T14:34:00.000Z"),
      firing("c2", "crit-key", "critical", "2026-11-16T14:35:00.000Z"),
      {
        eventId: "done:crit-key:later",
        receivedAt: "2026-11-16T15:48:00.000Z",
        body: JSON.stringify({ alert_key: "crit-key", action: "DONE", firing_event_id: "c1" }),
      },
    ]);
    const episodes = threads.filter((thread) => thread.alertKey === "crit-key");
    expect(episodes.find((thread) => thread.firingEventId === "c1")?.done).toEqual({ note: null });
    expect(episodes.find((thread) => thread.firingEventId === "c2")).toMatchObject({ attention: "open", done: null });
  });

  it("keeps a typed reply on the firing it names", () => {
    const threads = projectThreads([
      firing("c1", "crit-key", "critical", "2026-11-16T16:19:00.000Z"),
      resolved("r1", "crit-key", "critical", "2026-11-16T16:20:00.000Z"),
      firing("c2", "crit-key", "critical", "2026-11-16T16:21:00.000Z"),
      {
        eventId: "reply:C0:2.2",
        receivedAt: "2026-11-16T16:22:00.000Z",
        body: JSON.stringify({
          alert_key: "crit-key",
          firing_event_id: "c1",
          text: "cleared the filter",
          actor: "U1",
        }),
      },
    ]);
    const episodes = threads.filter((thread) => thread.alertKey === "crit-key");
    expect(episodes.find((thread) => thread.firingEventId === "c1")).toMatchObject({
      attention: "open",
      condition: "cleared",
      done: null,
      eventIds: ["c1", "r1", "reply:C0:2.2"],
    });
    expect(episodes.find((thread) => thread.firingEventId === "c2")?.eventIds).toEqual(["c2"]);
  });

  it("keeps a second firing on the open episode", () => {
    const threads = projectThreads([
      firing("c1", "crit-key", "critical", "2026-11-15T14:00:00.000Z"),
      firing("c2", "crit-key", "critical", "2026-11-15T14:02:00.000Z"),
    ]);
    expect(threads.filter((thread) => thread.alertKey === "crit-key")).toMatchObject([
      { firingEventId: "c1", condition: "firing", attention: "open", eventIds: ["c1", "c2"] },
    ]);
  });

  it("updates severity on the open episode without opening a new one", () => {
    const threads = projectThreads([
      firing("w1", "room-key", "warning", "2026-11-18T14:00:00.000Z"),
      firing("c1", "room-key", "critical", "2026-11-18T14:05:00.000Z"),
    ]);
    expect(threads.filter((thread) => thread.alertKey === "room-key")).toMatchObject([
      {
        firingEventId: "w1",
        condition: "firing",
        attention: "open",
        severity: "critical",
        peakSeverity: "critical",
        eventIds: ["w1", "c1"],
      },
    ]);
  });

  it("keeps peakSeverity after a downgrade while severity tracks the latest", () => {
    const threads = projectThreads([
      firing("w1", "room-key", "warning", "2026-11-18T14:00:00.000Z"),
      firing("c1", "room-key", "critical", "2026-11-18T14:05:00.000Z"),
      firing("w2", "room-key", "warning", "2026-11-18T14:10:00.000Z"),
    ]);
    expect(find(threads, "room-key")).toMatchObject({
      firingEventId: "w1",
      severity: "warning",
      peakSeverity: "critical",
      attention: "open",
      condition: "firing",
      eventIds: ["w1", "c1", "w2"],
    });
  });

  it("clears Done and reopens attention when severity returns to critical", () => {
    const threads = projectThreads([
      firing("w1", "room-key", "warning", "2026-11-18T14:00:00.000Z"),
      firing("c1", "room-key", "critical", "2026-11-18T14:01:00.000Z"),
      {
        eventId: "done:room-key:1",
        receivedAt: "2026-11-18T14:02:00.000Z",
        body: JSON.stringify({ alert_key: "room-key", action: "DONE", firing_event_id: "w1" }),
      },
      firing("w2", "room-key", "warning", "2026-11-18T14:03:00.000Z"),
      firing("c2", "room-key", "critical", "2026-11-18T14:04:00.000Z"),
    ]);
    expect(find(threads, "room-key")).toMatchObject({
      firingEventId: "w1",
      attention: "open",
      done: null,
      severity: "critical",
    });
  });

  it("classifies open, repeat, and severity_update FIRING arrivals", () => {
    const warning = firing("w1", "room-key", "warning", "2026-11-18T14:00:00.000Z");
    const critical = firing("c1", "room-key", "critical", "2026-11-18T14:05:00.000Z");
    const again = firing("c2", "room-key", "critical", "2026-11-18T14:06:00.000Z");

    expect(classifyFiringArrival([], "room-key", "w1", "warning")).toEqual({
      kind: "open",
      previousSeverity: null,
      openingEventId: null,
    });
    expect(classifyFiringArrival([warning, critical], "room-key", "c1", "critical")).toEqual({
      kind: "severity_update",
      previousSeverity: "warning",
      openingEventId: "w1",
    });
    expect(classifyFiringArrival([warning, critical, again], "room-key", "c2", "critical")).toEqual({
      kind: "repeat",
      previousSeverity: "critical",
      openingEventId: "w1",
    });
    expect(classifyFiringArrival([warning, critical], "other-key", "x1", "warning").kind).toBe("open");
  });

  it("ignores tag names when choosing attention", () => {
    const threads = projectThreads([
      firing("w", "tag-key", "warning", "2026-11-15T14:00:00.000Z", {
        time_series_tags: { alarm_severity: "critical", asset_id: "ROOM-01" },
      }),
    ]);
    expect(find(threads, "tag-key").attention).toBe("recorded");
  });

  it("carries team and manual presence without branching on them", () => {
    const threads = projectThreads([
      firing("a", "manual-key", "critical", "2026-11-15T14:00:00.000Z", {
        team: "payments-oncall",
        manual_url: "",
      }),
    ]);
    expect(find(threads, "manual-key")).toMatchObject({
      team: "payments-oncall",
      manualPresent: false,
      attention: "open",
    });
  });
});

describe("GET /v1/threads", () => {
  let log: AlertLog;
  let server: Server;
  let base: string;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    log.close();
  });

  it("projects the stored samples", async () => {
    log = openLog(":memory:");
    server = createIntakeServer(log);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;

    await post("docs/alert-samples/01.1-warning-firing.json");
    await post("docs/alert-samples/02.1-warning-resolved.json");
    await post("docs/alert-samples/03.1-critical-firing.json");
    await post("docs/alert-samples/05-service-firing.json");

    const response = await fetch(`${base}/v1/threads`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { threads: Thread[] };
    expect(find(body.threads, "mon-dc-building:job-room-01:a0f87b2057b3eb10")).toMatchObject({
      attention: "recorded",
      condition: "cleared",
    });
    expect(find(body.threads, "mon-dc-building:job-room-01:2c874b5443891358")).toMatchObject({
      attention: "open",
      condition: "firing",
    });
    expect(find(body.threads, "mon-checkout:job-api:9f2c1a0b7e44d618")).toMatchObject({
      attention: "recorded",
      team: "payments-oncall",
    });
  });

  function post(path: string): Promise<Response> {
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
});

function firing(
  eventId: string,
  alertKey: string,
  severity: string | null,
  receivedAt: string,
  extra: Record<string, unknown> = {},
): StoredEvent {
  return stored(eventId, alertKey, "FIRING", severity, receivedAt, extra);
}

function resolved(
  eventId: string,
  alertKey: string,
  severity: string | null,
  receivedAt: string,
  extra: Record<string, unknown> = {},
): StoredEvent {
  return stored(eventId, alertKey, "RESOLVED", severity, receivedAt, extra);
}

function stored(
  eventId: string,
  alertKey: string,
  transition: "FIRING" | "RESOLVED",
  severity: string | null,
  receivedAt: string,
  extra: Record<string, unknown>,
): StoredEvent {
  return {
    eventId,
    receivedAt,
    body: JSON.stringify({
      event_id: eventId,
      alert_key: alertKey,
      transition,
      severity,
      team: "facility-ops",
      manual_url: "https://example.test/runbook",
      ...extra,
    }),
  };
}

function find(threads: Thread[], alertKey: string): Thread {
  const thread = threads.find((item) => item.alertKey === alertKey);
  if (!thread) throw new Error(`missing thread ${alertKey}`);
  return thread;
}
