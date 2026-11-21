import { describe, expect, it } from "vitest";
import { parsePlotRow, renderTrends } from "../evals/plot-runs.ts";

describe("eval run plots", () => {
  it("parses current and older jsonl shapes", () => {
    const modern = parsePlotRow(
      JSON.stringify({
        runId: "2026-11-17T21-30-21-655Z",
        id: "older-done-newer-firing",
        prompt_version: "summary-prompt-v2",
        model: "grok-4.7",
        latencyMs: 9000,
        ok: true,
        usage: { prompt: 100, completion: 20, total: 150 },
      }),
    );
    expect(modern).toMatchObject({
      id: "older-done-newer-firing",
      ok: true,
      usage: { prompt: 100, completion: 20, total: 150 },
    });

    const older = parsePlotRow(
      JSON.stringify({
        runId: "2026-11-17T15-54-54-030Z",
        id: "older-done-newer-firing",
        prompt_version: "summary-prompt-v1",
        model: "grok-4.7",
        latencyMs: 5000,
        ok: false,
      }),
    );
    expect(older?.usage).toBeNull();
    expect(older?.ok).toBe(false);
  });

  it("renders pass, latency, and token sections", () => {
    const html = renderTrends([
      {
        runId: "2026-11-17T18-59-23-860Z",
        id: "older-done-newer-firing",
        prompt_version: "summary-prompt-v2",
        model: "grok-4.7",
        latencyMs: 8000,
        ok: true,
        usage: { prompt: 1969, completion: 91, total: 2524 },
      },
      {
        runId: "2026-11-17T21-30-21-655Z",
        id: "older-done-newer-firing",
        prompt_version: "summary-prompt-v2",
        model: "grok-4.7",
        latencyMs: 12000,
        ok: false,
        usage: null,
      },
    ]);
    expect(html).toContain("Pass / fail over time");
    expect(html).toContain("Latency");
    expect(html).toContain("Tokens");
    expect(html).toContain("total − (prompt + completion)");
    expect(html).toContain("older-done-newer-firing");
  });
});
