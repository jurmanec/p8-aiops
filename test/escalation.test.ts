import { describe, expect, it } from "vitest";
import { ESCALATION_WAIT_MS, NEXT_CONTACT, escalationEventId, runEscalations } from "../src/escalation.ts";
import { openLog } from "../src/log.ts";
import { projectThreads } from "../src/thread.ts";

const OPENED = "2026-11-15T14:00:00.000Z";

describe("escalation", () => {
  it("contacts the next person one wait after an unanswered critical alert", () => {
    const log = openLog(":memory:");
    log.save("c", alert("crit-key", "FIRING", "critical"), OPENED);

    expect(runEscalations(log, new Date(Date.parse(OPENED) + ESCALATION_WAIT_MS - 1))).toEqual([]);
    expect(runEscalations(log, new Date(Date.parse(OPENED) + ESCALATION_WAIT_MS))).toEqual(["crit-key"]);
    expect(runEscalations(log, new Date(Date.parse(OPENED) + ESCALATION_WAIT_MS + 60_000))).toEqual([]);

    const thread = projectThreads(log.list()).find((item) => item.alertKey === "crit-key");
    expect(thread).toMatchObject({
      attention: "open",
      condition: "firing",
      escalation: { next: NEXT_CONTACT },
    });
    expect(log.get(escalationEventId("crit-key", "c"))).toBeDefined();
    log.close();
  });

  it("does not escalate a warning or an owned thread, and does escalate the firing that follows an early resolve", () => {
    const log = openLog(":memory:");
    log.save("w", alert("warn-key", "FIRING", "warning"), OPENED);
    log.save("owned", alert("owned-key", "FIRING", "critical"), OPENED);
    log.save(
      "response:owned-key",
      JSON.stringify({ alert_key: "owned-key", action: "WORKING_ON_IT" }),
      "2026-11-15T14:05:00.000Z",
    );
    log.save("early-resolve", alert("early-key", "RESOLVED", "critical"), OPENED);
    log.save("early-fire", alert("early-key", "FIRING", "critical"), "2026-11-15T14:01:00.000Z");

    const later = new Date(Date.parse(OPENED) + ESCALATION_WAIT_MS + 60_000);
    expect(runEscalations(log, later)).toEqual(["early-key"]);
    log.close();
  });

  it("does not escalate after the person marks the loop done", () => {
    const log = openLog(":memory:");
    log.save("c", alert("done-key", "FIRING", "critical"), OPENED);
    log.save(
      "done:done-key:2026-11-15T14:10:00.000Z",
      JSON.stringify({ alert_key: "done-key", action: "DONE", note: "loop is closed" }),
      "2026-11-15T14:10:00.000Z",
    );

    expect(runEscalations(log, new Date(Date.parse(OPENED) + ESCALATION_WAIT_MS))).toEqual([]);
    log.close();
  });

  it("still escalates when the condition cleared and nobody answered", () => {
    const log = openLog(":memory:");
    log.save("c", alert("crit-key", "FIRING", "critical", "payments-oncall"), OPENED);
    log.save("r", alert("crit-key", "RESOLVED", "critical", "payments-oncall"), "2026-11-15T14:10:00.000Z");

    expect(runEscalations(log, new Date(Date.parse(OPENED) + ESCALATION_WAIT_MS))).toEqual(["crit-key"]);
    expect(projectThreads(log.list()).find((item) => item.alertKey === "crit-key")).toMatchObject({
      attention: "open",
      condition: "cleared",
      team: "payments-oncall",
      escalation: { next: NEXT_CONTACT },
    });
    log.close();
  });

  it("keeps the escalation when someone answers afterward", () => {
    const log = openLog(":memory:");
    log.save("c", alert("crit-key", "FIRING", "critical"), OPENED);
    runEscalations(log, new Date(Date.parse(OPENED) + ESCALATION_WAIT_MS));
    log.save(
      "response:crit-key",
      JSON.stringify({ alert_key: "crit-key", action: "IGNORE_IT", note: "known fault" }),
      "2026-11-15T14:20:00.000Z",
    );

    expect(projectThreads(log.list()).find((item) => item.alertKey === "crit-key")).toMatchObject({
      attention: "ignored",
      escalation: { next: NEXT_CONTACT },
      response: { action: "IGNORE_IT", note: "known fault" },
    });
    log.close();
  });
});

function alert(alertKey: string, transition: "FIRING" | "RESOLVED", severity: string, team = "facility-ops"): string {
  return JSON.stringify({
    event_id: `${alertKey}-${transition}`,
    alert_key: alertKey,
    transition,
    severity,
    team,
    manual_url: "https://example.test/runbook",
    summary: "pump fault",
  });
}
