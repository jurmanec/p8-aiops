import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { openLog } from "../src/log.ts";
import { buildShiftReport } from "../src/report.ts";
import { createIntakeServer } from "../src/server.ts";
import type { SummaryRunRecord, SummaryRunSink } from "../src/summary-run-log.ts";
import {
  SUMMARY_PROMPT_VERSION,
  SUMMARY_REASONING_EFFORT,
  summarizeWindow,
  summaryBrief,
  summaryRequestParams,
  type Summarizer,
} from "../src/summary.ts";

const START = "2026-11-16T14:00:00.000Z";
const END = "2026-11-16T16:00:00.000Z";
const KEY = "crit-key";

describe("window summary", () => {
  it("hands the model the episode facts and the typed reply", async () => {
    const log = openLog(":memory:");
    save(log, firing("c1", "2026-11-16T14:18:00.000Z"), "2026-11-16T14:18:00.000Z");
    save(log, resolved("r1", "2026-11-16T14:34:00.000Z"), "2026-11-16T14:34:00.000Z");
    log.save(
      "reply:C0:2.2",
      JSON.stringify({ alert_key: KEY, firing_event_id: "c1", text: "filter was blocked", actor: "bao" }),
      "2026-11-16T14:40:00.000Z",
    );
    const seen: string[] = [];
    const summarizer: Summarizer = async (brief) => {
      seen.push(brief);
      return "Ada closed the loop after the filter blocked.";
    };

    const paragraph = await summarizeWindow(log.list(), START, END, summarizer);

    expect(paragraph).toBe("Ada closed the loop after the filter blocked.");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("filter was blocked");
    expect(seen[0]).toContain("Reply from bao");
    expect(seen[0]).toContain("Identity: asset_id=ROOM-01, hall_id=HALL-01");
    expect(seen[0]).toContain("Fired at: 2026-11-16T14:18:00.000Z");
    expect(seen[0]).toContain("Condition: cleared");
    expect(seen[0]).toContain("Attention: open");
    expect(seen[0]).toContain("condition cleared, human not done");
    expect(seen[0]).toContain("Attention open: 1");
    expect(seen[0]).toContain("Condition firing: 0");
    expect(seen[0]).toContain("Escalated: 0");
    expect(seen[0]).toContain("Missing manual: 1");
    expect(seen[0]).toContain("Discrepancies: 1");
    expect(summaryBrief(log.list(), START, END)).toBe(seen[0]);
    log.close();
  });

  it("prefers identity_tags over labels for the brief", () => {
    const log = openLog(":memory:");
    save(
      log,
      [
        "c1",
        JSON.stringify({
          event_id: "c1",
          alert_key: KEY,
          transition: "FIRING",
          severity: "critical",
          summary: "row count high",
          fired_at: "2026-11-16T14:18:00.000Z",
          labels: { asset_id: "FROM-LABELS", hall_id: "HALL-L" },
          identity_tags: { asset_id: "ROOM-01", hall_id: "HALL-01" },
        }),
      ],
      "2026-11-16T14:18:00.000Z",
    );
    const brief = summaryBrief(log.list(), START, END);
    expect(brief).toContain("Identity: asset_id=ROOM-01, hall_id=HALL-01");
    expect(brief).not.toContain("FROM-LABELS");
    log.close();
  });

  it("returns the paragraph from the report page and leaves the log unchanged", async () => {
    const log = openLog(":memory:");
    save(log, firing("c1", "2026-11-16T14:18:00.000Z"), "2026-11-16T14:18:00.000Z");
    const server = createIntakeServer(log, { summarize: async () => "One episode cleared with no Done." });
    const base = await listen(server);

    const response = await fetch(`${base}/v1/summary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: START, end: END }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paragraph: "One episode cleared with no Done." });
    expect(log.list().some((event) => event.eventId.startsWith("shift:"))).toBe(false);
    expect(buildShiftReport(log.list(), START, END).model).toBeNull();

    await close(server);
    log.close();
  });

  it("skips the call when no model is configured", async () => {
    const log = openLog(":memory:");
    save(log, firing("c1", "2026-11-16T14:18:00.000Z"), "2026-11-16T14:18:00.000Z");
    const server = createIntakeServer(log, { summarize: null });
    const base = await listen(server);

    const response = await fetch(`${base}/v1/summary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: START, end: END }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paragraph: null });
    expect(log.list()).toHaveLength(1);

    await close(server);
    log.close();
  });

  it("appends a live run-log row without touching the alert log", async () => {
    const log = openLog(":memory:");
    save(log, firing("c1", "2026-11-16T14:18:00.000Z"), "2026-11-16T14:18:00.000Z");
    const rows: SummaryRunRecord[] = [];
    const runLog = memoryRunLog(rows);
    const params = summaryRequestParams(process.env);

    const paragraph = await summarizeWindow(
      log.list(),
      START,
      END,
      async () => ({ content: "Still firing in ROOM-01.", usage: { prompt: 10, completion: 4, total: 14 }, params }),
      { runLog, params },
    );

    expect(paragraph).toBe("Still firing in ROOM-01.");
    expect(log.list()).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "live",
      prompt_version: SUMMARY_PROMPT_VERSION,
      model: params.model,
      params: {
        model: params.model,
        stream: false,
        reasoning_effort: SUMMARY_REASONING_EFFORT,
        temperature: null,
      },
      windowStart: START,
      windowEnd: END,
      paragraph: "Still firing in ROOM-01.",
      error: null,
      skipped: null,
      usage: { prompt: 10, completion: 4, total: 14 },
    });
    expect(rows[0].brief).toContain("Episode c1");
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
    log.close();
  });

  it("records empty_window and no_model skips on the run log", async () => {
    const emptyLog = openLog(":memory:");
    const emptyRows: SummaryRunRecord[] = [];
    expect(await summarizeWindow(emptyLog.list(), START, END, async () => "nope", { runLog: memoryRunLog(emptyRows) })).toBeNull();
    expect(emptyRows).toHaveLength(1);
    expect(emptyRows[0].skipped).toBe("empty_window");
    expect(emptyRows[0].paragraph).toBe("");
    emptyLog.close();

    const noModelLog = openLog(":memory:");
    save(noModelLog, firing("c1", "2026-11-16T14:18:00.000Z"), "2026-11-16T14:18:00.000Z");
    const noModelRows: SummaryRunRecord[] = [];
    expect(await summarizeWindow(noModelLog.list(), START, END, null, { runLog: memoryRunLog(noModelRows) })).toBeNull();
    expect(noModelRows).toHaveLength(1);
    expect(noModelRows[0].skipped).toBe("no_model");
    noModelLog.close();
  });

  it("records API failure on the run log and still fails the HTTP call", async () => {
    const log = openLog(":memory:");
    save(log, firing("c1", "2026-11-16T14:18:00.000Z"), "2026-11-16T14:18:00.000Z");
    const rows: SummaryRunRecord[] = [];
    const server = createIntakeServer(log, {
      summarize: async () => {
        throw new Error("summary failed");
      },
      summaryRunLog: memoryRunLog(rows),
    });
    const base = await listen(server);

    const response = await fetch(`${base}/v1/summary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ start: START, end: END }),
    });
    expect(response.status).toBe(502);
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBe("summary failed");
    expect(rows[0].paragraph).toBe("");
    expect(rows[0].skipped).toBeNull();
    expect(log.list()).toHaveLength(1);

    await close(server);
    log.close();
  });
});

function memoryRunLog(rows: SummaryRunRecord[]): SummaryRunSink {
  return { append: (row) => rows.push(row) };
}

function save(log: ReturnType<typeof openLog>, row: [string, string], at: string): void {
  log.save(row[0], row[1], at);
}

function firing(eventId: string, at: string): [string, string] {
  return [
    eventId,
    JSON.stringify({
      event_id: eventId,
      alert_key: KEY,
      transition: "FIRING",
      severity: "critical",
      summary: "row count high",
      fired_at: at,
      identity_tags: { asset_id: "ROOM-01", hall_id: "HALL-01" },
    }),
  ];
}

function resolved(eventId: string, at: string): [string, string] {
  return [eventId, JSON.stringify({ event_id: eventId, alert_key: KEY, transition: "RESOLVED", severity: "critical", resolved_at: at })];
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
