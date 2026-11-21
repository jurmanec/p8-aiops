/**
 * Build a static trends page from evals/runs/*.jsonl.
 * Usage: npm run eval:plots
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type PlotRow = {
  runId: string;
  id: string;
  prompt_version: string;
  model: string;
  latencyMs: number;
  ok: boolean;
  usage: { prompt: number; completion: number; total: number } | null;
};

const thisFile = fileURLToPath(import.meta.url);
const evalRoot = dirname(thisFile);
const runsRoot = join(evalRoot, "runs");
const outPath = join(runsRoot, "trends.html");

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const rows = loadPlotRows(runsRoot);
  mkdirSync(runsRoot, { recursive: true });
  writeFileSync(outPath, renderTrends(rows), "utf8");
  console.log(`rows: ${rows.length} from ${new Set(rows.map((r) => r.runId)).size} run file(s)`);
  console.log(`wrote ${outPath}`);
}

export function loadPlotRows(dir: string): PlotRow[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const rows: PlotRow[] = [];
  for (const name of names) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = parsePlotRow(trimmed);
      if (row) rows.push(row);
    }
  }
  return rows.sort((a, b) => a.runId.localeCompare(b.runId) || a.id.localeCompare(b.id));
}

export function parsePlotRow(line: string): PlotRow | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || typeof record.id !== "string") return null;
  if (typeof record.prompt_version !== "string" || typeof record.model !== "string") return null;
  if (typeof record.latencyMs !== "number" || typeof record.ok !== "boolean") return null;
  return {
    runId: record.runId,
    id: record.id,
    prompt_version: record.prompt_version,
    model: record.model,
    latencyMs: record.latencyMs,
    ok: record.ok,
    usage: usageOf(record.usage),
  };
}

function usageOf(usage: unknown): PlotRow["usage"] {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const prompt = asNonNeg(record.prompt);
  const completion = asNonNeg(record.completion);
  const total = asNonNeg(record.total);
  if (prompt === null || completion === null || total === null) return null;
  return { prompt, completion, total };
}

function asNonNeg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function renderTrends(rows: PlotRow[]): string {
  const files = new Set(rows.map((r) => r.runId)).size;
  const withUsage = rows.filter((r) => r.usage);
  const passChart = sparkChart(
    rows.map((r, i) => ({ i, y: r.ok ? 1 : 0, ok: r.ok, label: shortRun(r.runId) })),
    { yMax: 1, yTicks: [0, 1], yFormat: (v) => (v >= 1 ? "pass" : "fail"), height: 120 },
  );
  const latencyChart = sparkChart(
    rows.map((r, i) => ({ i, y: r.latencyMs, ok: r.ok, label: shortRun(r.runId) })),
    { yMax: Math.max(1, ...rows.map((r) => r.latencyMs)), yFormat: (v) => `${Math.round(v)}ms`, height: 160 },
  );
  const tokenChart =
    withUsage.length === 0
      ? `<p class="empty">No token usage on these rows yet.</p>`
      : multiSeriesChart(
          withUsage.map((r, i) => ({
            i,
            label: shortRun(r.runId),
            prompt: r.usage!.prompt,
            completion: r.usage!.completion,
            total: r.usage!.total,
            gap: Math.max(0, r.usage!.total - r.usage!.prompt - r.usage!.completion),
          })),
        );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval run trends</title>
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
    --line-ink: #3d4654;
    --prompt: #2f5d8c;
    --completion: #6b5a2e;
    --total: #1c1f24;
    --gap: #8a5a2b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 400 14px/1.45 ui-sans-serif, system-ui, sans-serif;
  }
  header, main { padding: 20px 28px; max-width: 1100px; margin: 0 auto; }
  h1 { margin: 0; font-size: 20px; font-weight: 500; }
  h2 { margin: 0 0 10px; font-size: 15px; font-weight: 500; }
  .meta { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
  .panel {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    margin-bottom: 16px;
  }
  .empty { margin: 0; color: var(--muted); }
  svg { display: block; width: 100%; height: auto; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px 18px; margin: 8px 0 0; color: var(--muted); font-size: 12px; }
  .legend span::before {
    content: "";
    display: inline-block;
    width: 10px;
    height: 10px;
    margin-right: 6px;
    border-radius: 2px;
    vertical-align: -1px;
  }
  .legend .prompt::before { background: var(--prompt); }
  .legend .completion::before { background: var(--completion); }
  .legend .total::before { background: var(--total); }
  .legend .gap::before { background: var(--gap); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; border-top: 0; }
  .ok { color: var(--ok); }
  .fail { color: var(--fail); }
  .mono { font: 400 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<header>
  <h1>Eval run trends</h1>
  <p class="meta">${rows.length} row(s) · ${files} run file(s) · from evals/runs/*.jsonl</p>
</header>
<main>
  <section class="panel">
    <h2>Pass / fail over time</h2>
    ${rows.length ? passChart : `<p class="empty">No run files yet. Live evals write evals/runs/&lt;runId&gt;.jsonl.</p>`}
  </section>
  <section class="panel">
    <h2>Latency</h2>
    ${rows.length ? latencyChart : `<p class="empty">No latency data.</p>`}
  </section>
  <section class="panel">
    <h2>Tokens</h2>
    ${tokenChart}
    ${withUsage.length ? `<p class="legend"><span class="prompt">prompt</span><span class="completion">completion</span><span class="total">total</span><span class="gap">total − (prompt + completion)</span></p>` : ""}
  </section>
  <section class="panel">
    <h2>Rows</h2>
    ${rowsTable(rows)}
  </section>
</main>
</body>
</html>
`;
}

function shortRun(runId: string): string {
  return runId.length > 19 ? runId.slice(11, 19) : runId;
}

function sparkChart(
  points: Array<{ i: number; y: number; ok: boolean; label: string }>,
  opts: { yMax: number; yTicks?: number[]; yFormat: (v: number) => string; height: number },
): string {
  if (points.length === 0) return `<p class="empty">No points.</p>`;
  const width = 960;
  const height = opts.height;
  const pad = { top: 16, right: 16, bottom: 36, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const yMax = Math.max(opts.yMax, 1e-9);
  const xOf = (i: number) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yOf = (y: number) => pad.top + plotH - (y / yMax) * plotH;
  const path = points.map((p, idx) => `${idx === 0 ? "M" : "L"}${xOf(p.i).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(" ");
  const dots = points
    .map((p) => {
      const color = p.ok ? "var(--ok)" : "var(--fail)";
      return `<circle cx="${xOf(p.i).toFixed(1)}" cy="${yOf(p.y).toFixed(1)}" r="4" fill="${color}"><title>${escapeHtml(p.label)}: ${escapeHtml(opts.yFormat(p.y))}</title></circle>`;
    })
    .join("");
  const ticks = (opts.yTicks ?? niceTicks(yMax)).map((tick) => {
    const y = yOf(tick);
    return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="var(--line)" /><text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="11">${escapeHtml(opts.yFormat(tick))}</text>`;
  });
  const xLabels = points
    .map((p, idx) => {
      if (points.length > 12 && idx !== 0 && idx !== points.length - 1 && idx % Math.ceil(points.length / 8) !== 0) return "";
      return `<text x="${xOf(p.i).toFixed(1)}" y="${height - 12}" text-anchor="middle" fill="var(--muted)" font-size="10">${escapeHtml(p.label)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="trend chart">${ticks.join("")}<path d="${path}" fill="none" stroke="var(--line-ink)" stroke-width="1.5" />${dots}${xLabels}</svg>`;
}

function multiSeriesChart(
  points: Array<{ i: number; label: string; prompt: number; completion: number; total: number; gap: number }>,
): string {
  const width = 960;
  const height = 200;
  const pad = { top: 16, right: 16, bottom: 36, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const yMax = Math.max(1, ...points.flatMap((p) => [p.prompt, p.completion, p.total, p.gap]));
  const groupW = plotW / Math.max(points.length, 1);
  const barW = Math.min(14, Math.max(4, groupW / 5));
  const yOf = (y: number) => pad.top + plotH - (y / yMax) * plotH;
  const ticks = niceTicks(yMax).map((tick) => {
    const y = yOf(tick);
    return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="var(--line)" /><text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="11">${Math.round(tick)}</text>`;
  });
  const bars = points
    .map((p) => {
      const cx = pad.left + p.i * groupW + groupW / 2;
      const series = [
        { key: "prompt", value: p.prompt, color: "var(--prompt)", dx: -1.5 * barW },
        { key: "completion", value: p.completion, color: "var(--completion)", dx: -0.5 * barW },
        { key: "total", value: p.total, color: "var(--total)", dx: 0.5 * barW },
        { key: "gap", value: p.gap, color: "var(--gap)", dx: 1.5 * barW },
      ];
      return series
        .map((s) => {
          const top = yOf(s.value);
          const h = Math.max(0, pad.top + plotH - top);
          return `<rect x="${(cx + s.dx).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"><title>${escapeHtml(p.label)} ${s.key}: ${s.value}</title></rect>`;
        })
        .join("");
    })
    .join("");
  const xLabels = points
    .map((p) => {
      const cx = pad.left + p.i * groupW + groupW / 2;
      return `<text x="${cx.toFixed(1)}" y="${height - 12}" text-anchor="middle" fill="var(--muted)" font-size="10">${escapeHtml(p.label)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="token chart">${ticks.join("")}${bars}${xLabels}</svg>`;
}

function niceTicks(max: number): number[] {
  if (max <= 1) return [0, 1];
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const nice = step * (max / step > 5 ? 2 : 1);
  const ticks = [0];
  for (let v = nice; v < max; v += nice) ticks.push(v);
  ticks.push(max);
  return ticks;
}

function rowsTable(rows: PlotRow[]): string {
  if (rows.length === 0) return `<p class="empty">No rows.</p>`;
  const body = rows
    .map((r) => {
      const usage = r.usage
        ? `${r.usage.prompt} + ${r.usage.completion} = ${r.usage.total}`
        : "—";
      const gap = r.usage ? String(Math.max(0, r.usage.total - r.usage.prompt - r.usage.completion)) : "—";
      return `<tr>
  <td class="mono">${escapeHtml(r.runId)}</td>
  <td>${escapeHtml(r.id)}</td>
  <td class="${r.ok ? "ok" : "fail"}">${r.ok ? "ok" : "FAIL"}</td>
  <td>${escapeHtml(r.prompt_version)}</td>
  <td>${escapeHtml(r.model)}</td>
  <td>${r.latencyMs}</td>
  <td class="mono">${usage}</td>
  <td class="mono">${gap}</td>
</tr>`;
    })
    .join("\n");
  return `<table>
<thead><tr><th>run</th><th>case</th><th>result</th><th>prompt</th><th>model</th><th>ms</th><th>tokens</th><th>gap</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
