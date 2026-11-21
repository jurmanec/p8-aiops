import { readFileSync, readdirSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { openLog, type AlertLog } from "../src/log.ts";
import { createIntakeServer } from "../src/server.ts";

const samples = readdirSync("docs/alert-samples")
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("intake", () => {
  let log: AlertLog;
  let server: Server;
  let base: string;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    log.close();
  });

  it("saves each sample once and treats a replay as a duplicate", async () => {
    await start();
    for (const name of samples) {
      const body = readFileSync(`docs/alert-samples/${name}`, "utf8");
      const eventId = JSON.parse(body).event_id as string;
      const saved = await post(body, eventId);
      expect(saved.status, name).toBe(202);
      expect(log.get(eventId)?.body).toBe(body);

      const replay = await post(body, eventId);
      expect(replay.status, name).toBe(200);
      expect(log.get(eventId)?.body).toBe(body);
    }
    expect(samples).toContain("05-service-firing.json");
    expect(samples).toContain("06-general-firing.json");
  });

  it("accepts two events that share an alert_key", async () => {
    await start();
    const firing = readFileSync("docs/alert-samples/01.1-warning-firing.json", "utf8");
    const resolved = readFileSync("docs/alert-samples/02.1-warning-resolved.json", "utf8");
    expect((await post(firing, JSON.parse(firing).event_id)).status).toBe(202);
    expect((await post(resolved, JSON.parse(resolved).event_id)).status).toBe(202);
  });

  it("rejects a body or header that does not match the contract", async () => {
    await start();
    const body = readFileSync("docs/alert-samples/01.1-warning-firing.json", "utf8");
    const eventId = JSON.parse(body).event_id as string;

    expect((await post(body, "other-id")).status).toBe(400);
    expect((await post(body, undefined)).status).toBe(400);
    expect((await post("{", eventId)).status).toBe(400);

    const missing = JSON.parse(body) as Record<string, unknown>;
    delete missing.labels;
    expect((await post(JSON.stringify(missing), eventId)).status).toBe(400);

    const badSeverity = JSON.parse(body) as Record<string, unknown>;
    badSeverity.severity = "severe";
    expect((await post(JSON.stringify(badSeverity), eventId)).status).toBe(400);

    const firingWithResolve = JSON.parse(body) as Record<string, unknown>;
    firingWithResolve.resolved_at = firingWithResolve.fired_at;
    expect((await post(JSON.stringify(firingWithResolve), eventId)).status).toBe(400);

    expect(log.get(eventId)).toBeUndefined();
  });

  it("serves the read-only alert page", async () => {
    await start();
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("/v1/threads");
    expect(html).toContain("/v1/events");
    expect(html).not.toContain("<form");
  });

  it("lists events and filters them by alert_key", async () => {
    await start();
    const raw = readFileSync("docs/alert-samples/03.1-critical-firing.json", "utf8");
    const firing = JSON.parse(raw) as { event_id: string; alert_key: string };
    expect((await post(raw, firing.event_id)).status).toBe(202);

    const all = (await (await fetch(`${base}/v1/events`)).json()) as { events: Array<{ eventId: string }> };
    expect(all.events.some((event) => event.eventId === firing.event_id)).toBe(true);

    const matched = (await (await fetch(`${base}/v1/events?alert_key=${encodeURIComponent(firing.alert_key)}`)).json()) as {
      events: Array<{ body: { alert_key: string } }>;
    };
    expect(matched.events.length).toBeGreaterThan(0);
    expect(matched.events.every((event) => event.body.alert_key === firing.alert_key)).toBe(true);

    const empty = (await (await fetch(`${base}/v1/events?alert_key=missing`)).json()) as { events: unknown[] };
    expect(empty.events).toEqual([]);
  });

  it("accepts a 0.3 alert with no monitor id and rejects one with no labels", async () => {
    await start();
    const body = JSON.parse(readFileSync("docs/alert-samples/06-general-firing.json", "utf8")) as Record<string, unknown>;
    expect(body.monitor_id).toBeUndefined();
    const saved = await post(JSON.stringify(body), body.event_id as string);
    expect(saved.status).toBe(202);

    const missingLabels: Record<string, unknown> = { ...body, event_id: "am:no-labels" };
    delete missingLabels.labels;
    const rejected = await post(JSON.stringify(missingLabels), "am:no-labels");
    expect(rejected.status).toBe(400);
  });

  it("stores an alert that omits severity and carries an unknown field", async () => {
    await start();
    const body = JSON.parse(readFileSync("docs/alert-samples/05-service-firing.json", "utf8")) as Record<string, unknown>;
    delete body.severity;
    body.extra = "ignored";
    const raw = JSON.stringify(body);
    const response = await post(raw, body.event_id as string);
    expect(response.status).toBe(202);
    expect(JSON.parse(log.get(body.event_id as string)?.body ?? "{}")).toMatchObject({ extra: "ignored" });
  });

  async function start(): Promise<void> {
    log = openLog(":memory:");
    server = createIntakeServer(log);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  }

  function post(body: string, eventId: string | undefined): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (eventId !== undefined) headers["x-p8-event-id"] = eventId;
    return fetch(`${base}/v1/alerts`, { method: "POST", headers, body });
  }
});
