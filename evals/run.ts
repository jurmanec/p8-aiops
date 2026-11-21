/**
 * Golden regression for the window summary.
 * Offline: loads frozen briefs and prints case ids (always).
 * Live: set EVAL_LIVE=1 (and XAI_API_KEY) to call the model, check must_mention / must_not,
 * write runs/<runId>.jsonl and a readable runs/<runId>.html.
 * Optional argv filters to one case id (same as freeze-brief).
 *
 * Usage:
 *   node --experimental-strip-types evals/run.ts
 *   node --experimental-strip-types evals/run.ts older-done-newer-firing
 *   EVAL_LIVE=1 node --experimental-strip-types evals/run.ts older-done-newer-firing
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { context, setAttributes } from "@arizeai/phoenix-otel";
import { registerPhoenix } from "../src/phoenix.ts";
import {
  SUMMARY_PROMPT_VERSION,
  summaryRequestParams,
  xaiDetailedSummarizer,
  type SummaryRequestParams,
  type TokenUsage,
} from "../src/summary.ts";

type CaseMeta = {
  id: string;
  prompt_version: string;
  must_mention: string[];
  must_not: string[];
  notes?: string;
};

type RunRow = {
  runId: string;
  id: string;
  prompt_version: string;
  case_prompt_version: string;
  model: string;
  params: SummaryRequestParams;
  latencyMs: number;
  ok: boolean;
  must_mention: string[];
  must_not: string[];
  notes: string;
  missing: string[];
  forbidden: string[];
  error: string | null;
  usage: TokenUsage | null;
  brief: string;
  paragraph: string;
};

const evalRoot = dirname(fileURLToPath(import.meta.url));
const goldenRoot = join(evalRoot, "golden");
const runsRoot = join(evalRoot, "runs");
const live = process.env.EVAL_LIVE === "1";
const onlyId = process.argv[2]?.trim() || null;

loadEnvFile(join(evalRoot, "..", ".env"));

const cases = loadCases(goldenRoot, onlyId);
if (cases.length === 0) {
  console.error(onlyId ? `no golden case matching: ${onlyId}` : "no golden cases under evals/golden/");
  process.exit(1);
}

console.log(`cases: ${cases.map((c) => c.meta.id).join(", ")}`);

if (!live) {
  console.log("offline only (set EVAL_LIVE=1 to call the model)");
  process.exit(0);
}

const summarizer = xaiDetailedSummarizer(process.env, { source: "eval" });
if (!summarizer) {
  console.error("EVAL_LIVE=1 but XAI_API_KEY is unset");
  process.exit(1);
}

const provider = registerPhoenix();

const intendedParams = summaryRequestParams(process.env);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const rows: RunRow[] = [];
let failed = 0;

try {
  for (const { meta, brief } of cases) {
    const started = Date.now();
    let paragraph = "";
    let usage: TokenUsage | null = null;
    let params = intendedParams;
    let error: string | null = null;
    try {
      const result = await context.with(
        setAttributes(context.active(), { "p8.case_id": meta.id, "p8.run_id": runId }),
        () => summarizer(brief),
      );
      paragraph = result.content.trim();
      usage = result.usage;
      params = result.params;
    } catch (err) {
      error = err instanceof Error ? err.message : "unknown";
    }
    const latencyMs = Date.now() - started;
    const missing = meta.must_mention.filter((s) => !paragraph.toLowerCase().includes(s.toLowerCase()));
    const forbidden = meta.must_not.filter((s) => paragraph.toLowerCase().includes(s.toLowerCase()));
    const ok = error === null && missing.length === 0 && forbidden.length === 0;
    if (!ok) failed += 1;

    const row: RunRow = {
      runId,
      id: meta.id,
      prompt_version: SUMMARY_PROMPT_VERSION,
      case_prompt_version: meta.prompt_version,
      model: params.model,
      params,
      latencyMs,
      ok,
      must_mention: meta.must_mention,
      must_not: meta.must_not,
      notes: typeof meta.notes === "string" ? meta.notes : "",
      missing,
      forbidden,
      error,
      usage,
      brief,
      paragraph,
    };
    rows.push(row);

    const tokenLabel = usage ? ` · ${usage.prompt}+${usage.completion}=${usage.total} tok` : "";
    console.log(`${ok ? "ok" : "FAIL"} ${meta.id} (${latencyMs}ms${tokenLabel})`);
    console.log(`  params: ${paramsLabel(params)}`);
    if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
    if (forbidden.length) console.log(`  forbidden: ${forbidden.join(", ")}`);
    if (error) console.log(`  error: ${error}`);
    if (paragraph) {
      console.log("  paragraph:");
      for (const line of paragraph.split("\n")) console.log(`    ${line}`);
    }
  }

  mkdirSync(runsRoot, { recursive: true });
  const jsonlPath = join(runsRoot, `${runId}.jsonl`);
  const htmlPath = join(runsRoot, `${runId}.html`);
  writeFileSync(jsonlPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  writeFileSync(htmlPath, renderHtml(runId, intendedParams.model, rows), "utf8");
  console.log(`wrote ${jsonlPath}`);
  console.log(`wrote ${htmlPath}`);
  console.log(`open ${htmlPath}`);
} finally {
  // Batch OTLP export drops spans if the process exits first (plan 004 step 5).
  await provider.shutdown();
}
process.exit(failed > 0 ? 1 : 0);

function loadCases(root: string, only: string | null): Array<{ meta: CaseMeta; brief: string }> {
  const out: Array<{ meta: CaseMeta; brief: string }> = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (only && name.name !== only) continue;
    const dir = join(root, name.name);
    const metaPath = join(dir, "meta.json");
    const briefPath = join(dir, "brief.txt");
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as CaseMeta;
      const brief = readFileSync(briefPath, "utf8").replace(/\n$/, "");
      if (meta.id !== name.name) throw new Error(`meta.id ${meta.id} != dir ${name.name}`);
      out.push({ meta, brief });
    } catch (err) {
      console.error(`skip ${name.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out.sort((a, b) => a.meta.id.localeCompare(b.meta.id));
}

function loadEnvFile(path: string): void {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const split = trimmed.indexOf("=");
      if (split <= 0) continue;
      const key = trimmed.slice(0, split).trim();
      if (process.env[key] === undefined) process.env[key] = trimmed.slice(split + 1).trim();
    }
  } catch {
    // optional
  }
}

function renderHtml(id: string, modelName: string, results: RunRow[]): string {
  const passed = results.filter((row) => row.ok).length;
  const cards = results.map((row) => caseCard(row)).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval run ${escapeHtml(id)}</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f4f5f7;
    --surface: #ffffff;
    --ink: #1c1f24;
    --muted: #5c6570;
    --line: #e3e6eb;
    --ok: #1f6b3a;
    --fail: #8d2f2f;
    --ok-bg: #e8f5ec;
    --fail-bg: #f8eaea;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 400 14px/1.45 ui-sans-serif, system-ui, sans-serif;
  }
  header, main { padding: 20px 28px; max-width: 960px; margin: 0 auto; }
  h1 { margin: 0; font-size: 20px; font-weight: 500; }
  .meta { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    margin-bottom: 16px;
  }
  .head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; margin-bottom: 12px; }
  .head h2 { margin: 0; font-size: 16px; font-weight: 500; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
  }
  .badge.ok { color: var(--ok); background: var(--ok-bg); }
  .badge.fail { color: var(--fail); background: var(--fail-bg); }
  .facts { color: var(--muted); font-size: 12px; }
  .notes { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
  .notes:empty { display: none; }
  .checks { margin: 0 0 12px; padding-left: 18px; color: var(--fail); }
  .checks:empty { display: none; }
  .criteria { margin: 0; padding: 0; list-style: none; }
  .criteria li {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: baseline;
    padding: 6px 0;
    border-top: 1px solid var(--line);
    font-size: 13px;
  }
  .criteria li:first-child { border-top: 0; }
  .kind { color: var(--muted); font-size: 12px; min-width: 6.5rem; }
  .hit { color: var(--ok); font-size: 12px; font-weight: 500; }
  .miss { color: var(--fail); font-size: 12px; font-weight: 500; }
  .panel { margin-top: 12px; }
  .panel h3 { margin: 0 0 6px; font-size: 12px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  pre {
    margin: 0;
    padding: 12px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 400 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .paragraph pre { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; }
</style>
</head>
<body>
<header>
  <h1>Window summary eval</h1>
  <p class="meta">${escapeHtml(id)} · ${escapeHtml(modelName)} · ${passed}/${results.length} passed · prompt ${escapeHtml(SUMMARY_PROMPT_VERSION)}</p>
</header>
<main>
${cards}
</main>
</body>
</html>
`;
}

function caseCard(row: RunRow): string {
  const checks: string[] = [];
  if (row.error) checks.push(`error: ${escapeHtml(row.error)}`);
  const criteria = [
    ...row.must_mention.map((item) => {
      const hit = !row.missing.includes(item);
      return `<li><span class="kind">must mention</span><span>${escapeHtml(item)}</span><span class="${hit ? "hit" : "miss"}">${hit ? "hit" : "miss"}</span></li>`;
    }),
    ...row.must_not.map((item) => {
      const clean = !row.forbidden.includes(item);
      return `<li><span class="kind">must not</span><span>${escapeHtml(item)}</span><span class="${clean ? "hit" : "miss"}">${clean ? "clean" : "present"}</span></li>`;
    }),
  ].join("");
  return `<article class="card">
  <div class="head">
    <h2>${escapeHtml(row.id)}</h2>
    <span class="badge ${row.ok ? "ok" : "fail"}">${row.ok ? "ok" : "FAIL"}</span>
    <span class="facts">${row.latencyMs}ms${usageLabel(row.usage)} · case prompt ${escapeHtml(row.case_prompt_version)}</span>
  </div>
  <p class="notes">${escapeHtml(row.notes)}</p>
  <ul class="checks">${checks.map((item) => `<li>${item}</li>`).join("")}</ul>
  <div class="panel">
    <h3>Request params</h3>
    <pre>${escapeHtml(paramsBlock(row.params))}</pre>
  </div>
  <div class="panel">
    <h3>Criteria</h3>
    <ul class="criteria">${criteria || "<li class=\"facts\">No must_mention / must_not checks.</li>"}</ul>
  </div>
  <div class="panel">
    <h3>Paragraph</h3>
    <div class="paragraph"><pre>${escapeHtml(row.paragraph || "(empty)")}</pre></div>
  </div>
  <div class="panel">
    <h3>Brief</h3>
    <pre>${escapeHtml(row.brief)}</pre>
  </div>
</article>`;
}

function usageLabel(usage: TokenUsage | null): string {
  if (!usage) return "";
  return ` · ${usage.prompt} prompt + ${usage.completion} completion = ${usage.total} tokens`;
}

function paramsLabel(params: SummaryRequestParams): string {
  const temperature = params.temperature === null ? "unset (provider default)" : String(params.temperature);
  return `model=${params.model} stream=${params.stream} reasoning_effort=${params.reasoning_effort} temperature=${temperature}`;
}

function paramsBlock(params: SummaryRequestParams): string {
  return [
    `model: ${params.model}`,
    `stream: ${params.stream}`,
    `reasoning_effort: ${params.reasoning_effort}`,
    `temperature: ${params.temperature === null ? "unset (provider default)" : params.temperature}`,
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
