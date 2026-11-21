import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SummaryRequestParams, TokenUsage } from "./summary.ts";

export const DEFAULT_SUMMARY_RUNS_PATH = "data/summary-runs.jsonl";

/** One `/v1/summary` attempt. Same core fields as eval JSONL; no golden rubric columns. */
export type SummaryRunRecord = {
  runId: string;
  source: "live";
  prompt_version: string;
  model: string;
  params: SummaryRequestParams;
  windowStart: string;
  windowEnd: string;
  latencyMs: number;
  brief: string;
  paragraph: string;
  error: string | null;
  usage: TokenUsage | null;
  /** Set when the model was not called. */
  skipped: "empty_window" | "no_model" | null;
};

export type SummaryRunSink = {
  append(record: SummaryRunRecord): void;
};

/** Append-only NDJSON file. Path default: `data/summary-runs.jsonl` (`P8_SUMMARY_RUNS`). */
export function openSummaryRunLog(path: string): SummaryRunSink {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append(record) {
      appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    },
  };
}

export function summaryRunsPath(env: NodeJS.ProcessEnv): string {
  const configured = env.P8_SUMMARY_RUNS?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_SUMMARY_RUNS_PATH;
}
