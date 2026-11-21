import { getLLMAttributes, getMetadataAttributes, traceLLM } from "@arizeai/phoenix-otel";
import type { StoredEvent } from "./log.ts";
import { buildShiftReport, type ShiftThread } from "./report.ts";
import type { SummaryRunSink } from "./summary-run-log.ts";

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_MODEL = "grok-4.7";
/** Sent on every chat completion; drives much of the total−(prompt+completion) token gap. */
export const SUMMARY_REASONING_EFFORT = "low";

/** Bump when the system prompt text changes in a way that should re-baseline golden cases. Frozen copy: docs/p8-program/agentic/prompts/summary/. */
export const SUMMARY_PROMPT_VERSION = "summary-prompt-v2";

/** System prompt for the shift summary. Rules that build the brief live in the log and concept notes, not here. */
export const SUMMARY_PROMPT = `You are the agentic layer of P8. Write a concise on-call shift report.

Prefer a few short paragraphs, or short bullets under clear headings if that is clearer.
Do not write a long essay. Aim for roughly half a page or less. One paragraph is fine when the window is simple.

Audiences: (1) the next person on call, (2) leads who need what is still open or actionable.

Lead with condition still firing, then attention still open, discrepancies, and escalations. Note cleared criticals briefly. Summarize warnings; call out any that have not cleared.

Describe episodes in human terms: place and series from Identity tags, when they Fired at, and whether the condition is still firing or cleared. Weave free-form "Reply from …" lines into that narrative. Prefer that language over metric Alert text or full episode ids.

The reader already has the report table of structured episode facts and can open Alerts with an episode id. Use a short episode-id suffix (for example "ending in 2211") only when two rows would otherwise be ambiguous. Do not recite full UUIDs when Identity and Fired at are enough.

Glossary for the brief: Condition is the producer track (firing/cleared). Attention is the human track (open/owned/ignored/recorded). Done closes the human loop and does not clear the condition. Discrepancy means Done and condition disagree on a paged episode. Escalation means a critical episode stayed unanswered for 15 minutes.

The brief is Window, then five stats (Attention open, Condition firing, Escalated, Missing manual, Discrepancies), then Episode lines (including Identity and Fired at), then Reply lines. Use only those facts. Do not invent events, people, times, places, or causes.

The brief should be interpreted as your memory of the events you observed during the shift.

Do not refer to attention explicitly with the word "attention". Prefer the human, narrative meaning instead.
Recorded means severity is low enough that human action is not required.
Open means no one has taken ownership of a critical alert and the next step is escalation.
Owned means someone has taken the alert and is working on it (they selected In progress).
Ignored means someone decided that no action is required (they selected Non actionable).`;

export type Summarizer = (brief: string) => Promise<string>;

/** Token counts from the model API when present. */
export type TokenUsage = {
  prompt: number;
  completion: number;
  total: number;
};

/** What we send on the chat completion (including unset sampling → provider default). */
export type SummaryRequestParams = {
  model: string;
  stream: false;
  reasoning_effort: string;
  /** null = not sent; provider default applies. */
  temperature: number | null;
};

export type DetailedSummary = {
  content: string;
  usage: TokenUsage | null;
  params: SummaryRequestParams;
};

/** Live call that returns the paragraph, usage, and request params. Used by evals and the runtime run log. */
export type DetailedSummarizer = (brief: string) => Promise<DetailedSummary>;

/** String or detailed summarizer; runtime prefers detailed so usage lands on the run log. */
export type SummarizerFn = Summarizer | DetailedSummarizer;

/** Phoenix / run-log tag: `/v1/summary` vs golden harness. Filter: `metadata['source'] == 'eval'`. */
export type SummaryTraceSource = "live" | "eval";

export type XaiSummarizerOptions = {
  source?: SummaryTraceSource;
};

/** Params for the current summary call shape. Shared by runtime and eval traces. */
export function summaryRequestParams(env: NodeJS.ProcessEnv): SummaryRequestParams {
  return {
    model: env.XAI_MODEL?.trim() || DEFAULT_MODEL,
    stream: false,
    reasoning_effort: SUMMARY_REASONING_EFFORT,
    temperature: null,
  };
}

/** The facts for one window. The same episodes as the report, plus each episode's typed replies. */
export function summaryBrief(events: StoredEvent[], start: string, end: string): string {
  const report = buildShiftReport(events, start, end);
  const lines = [`Window: ${start} to ${end}`];
  if (report.threads.length === 0) {
    lines.push("No episodes opened in this window.");
    return lines.join("\n");
  }
  const threads = report.threads;
  lines.push(
    `Attention open: ${threads.filter((thread) => thread.attention === "open").length}`,
    `Condition firing: ${threads.filter((thread) => thread.condition === "firing").length}`,
    `Escalated: ${threads.filter((thread) => typeof thread.escalation === "string" && thread.escalation.length > 0).length}`,
    `Missing manual: ${threads.filter((thread) => thread.manualPresent === false).length}`,
    `Discrepancies: ${threads.filter((thread) => typeof thread.discrepancy === "string" && thread.discrepancy.length > 0).length}`,
  );
  for (const thread of threads) {
    lines.push(episodeLine(events, thread));
    for (const reply of repliesFor(events, thread.firingEventId, end)) lines.push(reply);
  }
  return lines.join("\n");
}

export type SummarizeWindowOptions = {
  /** When set, every attempt (success, empty skip, no model, API error) appends one row. */
  runLog?: SummaryRunSink | null;
  /** Request params for the trace when the summarizer does not return them. */
  params?: SummaryRequestParams;
};

/** Ask for a paragraph. An empty window, or no model, returns nothing and leaves the alert log alone. */
export async function summarizeWindow(
  events: StoredEvent[],
  start: string,
  end: string,
  summarizer: SummarizerFn | null,
  options: SummarizeWindowOptions = {},
): Promise<string | null> {
  const params = options.params ?? summaryRequestParams(process.env);
  const started = Date.now();
  const brief = summaryBrief(events, start, end);
  const empty = buildShiftReport(events, start, end).threads.length === 0;

  const record = (fields: {
    paragraph: string | null;
    error?: string | null;
    usage?: TokenUsage | null;
    params?: SummaryRequestParams;
    skipped?: "empty_window" | "no_model" | null;
  }): void => {
    const sink = options.runLog;
    if (!sink) return;
    const used = fields.params ?? params;
    sink.append({
      runId: new Date().toISOString().replace(/[:.]/g, "-"),
      source: "live",
      prompt_version: SUMMARY_PROMPT_VERSION,
      model: used.model,
      params: used,
      windowStart: start,
      windowEnd: end,
      latencyMs: Date.now() - started,
      brief,
      paragraph: fields.paragraph ?? "",
      error: fields.error ?? null,
      usage: fields.usage ?? null,
      skipped: fields.skipped ?? null,
    });
  };

  if (empty) {
    record({ paragraph: null, skipped: "empty_window" });
    return null;
  }
  if (!summarizer) {
    record({ paragraph: null, skipped: "no_model" });
    return null;
  }

  try {
    const raw = await summarizer(brief);
    const detailed = detailedOf(raw, params);
    const paragraph = detailed.content.trim();
    const out = paragraph.length > 0 ? paragraph : null;
    record({
      paragraph: out,
      usage: detailed.usage,
      params: detailed.params,
      skipped: null,
      error: null,
    });
    return out;
  } catch (err) {
    record({
      paragraph: null,
      error: err instanceof Error ? err.message : "unknown",
      skipped: null,
    });
    throw err;
  }
}

function detailedOf(raw: string | DetailedSummary, fallback: SummaryRequestParams): DetailedSummary {
  if (typeof raw === "string") return { content: raw, usage: null, params: fallback };
  return raw;
}

/** Grok with usage and request params, when `XAI_API_KEY` is set. `XAI_MODEL` overrides the model name. */
export function xaiDetailedSummarizer(
  env: NodeJS.ProcessEnv,
  options: XaiSummarizerOptions = {},
): DetailedSummarizer | null {
  const key = env.XAI_API_KEY?.trim() ?? "";
  if (!key) return null;
  const source = options.source ?? "live";
  const params = summaryRequestParams(env);
  const invocationParameters: Record<string, unknown> = {
    stream: params.stream,
    reasoning_effort: params.reasoning_effort,
  };
  if (params.temperature !== null) invocationParameters.temperature = params.temperature;

  /** Manual OpenInference LLM span (plan 004 step 4). No-op exporter if Phoenix was not registered. */
  return traceLLM(
    async (brief: string): Promise<DetailedSummary> => {
      const body: Record<string, unknown> = {
        model: params.model,
        stream: params.stream,
        reasoning_effort: params.reasoning_effort,
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: brief },
        ],
      };
      if (params.temperature !== null) body.temperature = params.temperature;
      const response = await fetch(XAI_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("summary failed");
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: unknown;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) throw new Error("summary failed");
      return { content, usage: tokenUsageOf(payload.usage), params };
    },
    {
      name: "summary.xai",
      attributes: getMetadataAttributes({
        prompt_version: SUMMARY_PROMPT_VERSION,
        source,
      }),
      processInput: (brief: string) =>
        getLLMAttributes({
          provider: "xai",
          modelName: params.model,
          invocationParameters,
          inputMessages: [
            { role: "system", content: SUMMARY_PROMPT },
            { role: "user", content: brief },
          ],
        }),
      processOutput: (result: DetailedSummary) =>
        getLLMAttributes({
          modelName: result.params.model,
          outputMessages: [{ role: "assistant", content: result.content }],
          tokenCount: result.usage
            ? {
                prompt: result.usage.prompt,
                completion: result.usage.completion,
                total: result.usage.total,
              }
            : undefined,
        }),
    },
  );
}

/** Grok, when `XAI_API_KEY` is set. `XAI_MODEL` overrides the model name. */
export function xaiSummarizer(env: NodeJS.ProcessEnv, options?: XaiSummarizerOptions): Summarizer | null {
  const detailed = xaiDetailedSummarizer(env, options);
  if (!detailed) return null;
  return async (brief) => (await detailed(brief)).content;
}

function tokenUsageOf(usage: unknown): TokenUsage | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const prompt = asTokenCount(record.prompt_tokens);
  const completion = asTokenCount(record.completion_tokens);
  const total = asTokenCount(record.total_tokens);
  if (prompt === null && completion === null && total === null) return null;
  const promptN = prompt ?? 0;
  const completionN = completion ?? 0;
  return {
    prompt: promptN,
    completion: completionN,
    total: total ?? promptN + completionN,
  };
}

function asTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function episodeLine(events: StoredEvent[], thread: ShiftThread): string {
  const firing = events.find((event) => event.eventId === thread.firingEventId);
  const body = firing ? parse(firing.body) : null;
  const summary = body && typeof body.summary === "string" && body.summary.length > 0 ? body.summary : thread.alertKey;
  const parts = [
    `Episode ${thread.firingEventId}`,
    `Alert: ${summary}`,
    `Identity: ${identityOf(body)}`,
    `Fired at: ${firedAtOf(body)}`,
    `Severity: ${thread.severity ?? "none"}`,
    `Condition: ${thread.condition}`,
    `Attention: ${thread.attention}`,
    `Answer: ${thread.answer ?? "none"}`,
    `Done: ${thread.done ? "yes" : "no"}`,
    `Discrepancy: ${thread.discrepancy ?? "none"}`,
    `Escalation: ${thread.escalation ?? "none"}`,
  ];
  if (thread.note) parts.push(`Answer note: ${thread.note}`);
  if (thread.doneNote) parts.push(`Done note: ${thread.doneNote}`);
  return parts.join(". ");
}

/** Prefer identity_tags; else labels / time_series_tags. Opaque key=value list; no domain branching. */
function identityOf(body: Record<string, unknown> | null): string {
  const tags = stringMap(body?.identity_tags) ?? stringMap(body?.labels) ?? stringMap(body?.time_series_tags);
  if (!tags) return "none";
  const line = Object.keys(tags)
    .sort()
    .map((key) => `${key}=${tags[key]}`)
    .join(", ");
  return line.length > 0 ? line : "none";
}

function firedAtOf(body: Record<string, unknown> | null): string {
  return body && typeof body.fired_at === "string" && body.fired_at.length > 0 ? body.fired_at : "none";
}

function stringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function repliesFor(events: StoredEvent[], firingEventId: string, end: string): string[] {
  const endMs = Date.parse(end);
  const lines: string[] = [];
  for (const event of events) {
    if (!event.eventId.startsWith("reply:") || Date.parse(event.receivedAt) >= endMs) continue;
    const body = parse(event.body);
    if (!body || body.firing_event_id !== firingEventId || typeof body.text !== "string" || body.text.length === 0) continue;
    const actor = typeof body.actor === "string" && body.actor.length > 0 ? body.actor : "someone";
    lines.push(`Reply from ${actor}: ${body.text}`);
  }
  return lines;
}

function parse(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
