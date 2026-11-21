import { describe, expect, it } from "vitest";
import { openLog } from "../src/log.ts";
import { buildShiftReport, closeShift } from "../src/report.ts";
import { createIntakeServer } from "../src/server.ts";
import type { Server } from "node:http";

const START = "2026-11-15T14:00:00.000Z";
const END = "2026-11-15T22:00:00.000Z";

describe("shift report", () => {
  it("records what fired, who answered, how long it took, and what stayed open", () => {
    const log = openLog(":memory:");
    log.save("w", alert("warn-key", "FIRING", "warning"), "2026-11-15T14:10:00.000Z");
    log.save("c", alert("crit-key", "FIRING", "critical", ""), "2026-11-15T14:20:00.000Z");
    log.save(
      "response:crit-key",
      JSON.stringify({ alert_key: "crit-key", action: "WORKING_ON_IT", note: "on the floor" }),
      "2026-11-15T14:25:00.000Z",
    );
    log.save("late", alert("late-key", "FIRING", "critical"), "2026-11-15T22:00:00.000Z");
    log.save("early", alert("early-key", "FIRING", "critical"), "2026-11-15T13:59:00.000Z");
    log.save(
      "escalation:open-key",
      JSON.stringify({ alert_key: "open-key", next: "secondary-oncall" }),
      "2026-11-15T15:00:00.000Z",
    );
    log.save("o", alert("open-key", "FIRING", "critical"), "2026-11-15T14:30:00.000Z");

    const report = buildShiftReport(log.list(), START, END);
    expect(report.model).toBeNull();
    expect(report.openCount).toBe(1);
    expect(report.threads.map((thread) => thread.alertKey).sort()).toEqual(["crit-key", "open-key", "warn-key"]);
    expect(report.threads.find((thread) => thread.alertKey === "warn-key")).toMatchObject({
      severity: "warning",
      manualPresent: true,
      answer: null,
      open: false,
    });
    expect(report.threads.find((thread) => thread.alertKey === "crit-key")).toMatchObject({
      severity: "critical",
      manualPresent: false,
      condition: "firing",
      attention: "owned",
      answer: "WORKING_ON_IT",
      note: "on the floor",
      answerMs: 5 * 60 * 1000,
      escalation: null,
      open: false,
    });
    expect(report.threads.find((thread) => thread.alertKey === "open-key")).toMatchObject({
      open: true,
      answer: null,
      escalation: "secondary-oncall",
    });
    log.close();
  });

  it("reports peak severity when the episode later downgrades", () => {
    const log = openLog(":memory:");
    log.save("w1", alert("room-key", "FIRING", "warning"), "2026-11-15T14:10:00.000Z");
    log.save("c1", alert("room-key", "FIRING", "critical"), "2026-11-15T14:20:00.000Z");
    log.save("w2", alert("room-key", "FIRING", "warning"), "2026-11-15T14:30:00.000Z");

    const report = buildShiftReport(log.list(), START, END);
    expect(report.threads.find((thread) => thread.alertKey === "room-key")).toMatchObject({
      severity: "critical",
      condition: "firing",
      attention: "open",
      open: true,
    });
    log.close();
  });

  it("keeps the first report when the same window is closed again", () => {
    const log = openLog(":memory:");
    log.save("c", alert("crit-key", "FIRING", "critical"), "2026-11-15T14:20:00.000Z");
    const first = closeShift(log, START, END);
    log.save("w", alert("warn-key", "FIRING", "warning"), "2026-11-15T15:00:00.000Z");
    const second = closeShift(log, START, END);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.report.threads.map((thread) => thread.alertKey)).toEqual(["crit-key"]);
    log.close();
  });

  it("names a discrepancy when DONE and P2 RESOLVED disagree", () => {
    const log = openLog(":memory:");
    log.save("human", alert("human-key", "FIRING", "critical"), "2026-11-15T14:20:00.000Z");
    log.save(
      "done:human-key:2026-11-15T14:30:00.000Z",
      JSON.stringify({ alert_key: "human-key", action: "DONE", note: "loop is closed" }),
      "2026-11-15T14:30:00.000Z",
    );
    log.save("p2", alert("p2-key", "FIRING", "critical"), "2026-11-15T14:20:00.000Z");
    log.save("p2-clear", alert("p2-key", "RESOLVED", "critical"), "2026-11-15T14:40:00.000Z");

    const report = buildShiftReport(log.list(), START, END);
    expect(report.threads.find((thread) => thread.alertKey === "human-key")).toMatchObject({
      condition: "firing",
      doneNote: "loop is closed",
      discrepancy: "human done, condition still firing",
    });
    expect(report.threads.find((thread) => thread.alertKey === "p2-key")).toMatchObject({
      condition: "cleared",
      doneNote: null,
      discrepancy: "condition cleared, human not done",
    });
    log.close();
  });

  it("shows a window without closing the shift", async () => {
    const log = openLog(":memory:");
    log.save("c", alert("crit-key", "FIRING", "critical"), "2026-11-15T14:20:00.000Z");
    const server = createIntakeServer(log);
    const base = await listen(server);
    const response = await fetch(
      `${base}/v1/shifts?start=${encodeURIComponent(START)}&end=${encodeURIComponent(END)}`,
    );
    expect(response.status).toBe(200);
    const report = (await response.json()) as { threads: Array<{ alertKey: string; firingEventId: string }>; openCount: number };
    expect(report.openCount).toBe(1);
    expect(report.threads).toMatchObject([{ alertKey: "crit-key", firingEventId: "c" }]);
    expect(log.list().some((event) => event.eventId.startsWith("shift:"))).toBe(false);

    const rejected = await fetch(`${base}/v1/shifts?start=${encodeURIComponent(END)}&end=${encodeURIComponent(START)}`);
    expect(rejected.status).toBe(400);
    await close(server);
    log.close();
  });

  it("rejects a window whose start is not before its end", async () => {
    const log = openLog(":memory:");
    const server = createIntakeServer(log);
    const base = await listen(server);
    const response = await fetch(`${base}/v1/shifts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: END, end: START }),
    });
    expect(response.status).toBe(400);
    await close(server);
    log.close();
  });
});

function alert(alertKey: string, transition: "FIRING" | "RESOLVED", severity: string, manual = "https://example.test/runbook"): string {
  return JSON.stringify({
    event_id: `${alertKey}-${transition}`,
    alert_key: alertKey,
    transition,
    severity,
    team: "facility-ops",
    manual_url: manual,
    summary: "pump fault",
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
