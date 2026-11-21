# Phoenix (Arize)

Local UI for summary model traces (OpenTelemetry / OpenInference). Complements the NDJSON run log ([ADR_001](../adr/ADR_001-summary-model-call-logging.md)). File-log queries: [query-logs-with-jq](query-logs-with-jq.md).

P8 project name in Phoenix: **`p8-summary`**. Span name: **`summary.xai`**.

## Start

```sh
uvx arize-phoenix serve
```

Open [http://localhost:6006](http://localhost:6006). Prefer `uvx` for a local trial. Leave it running while `npm start` or live evals export spans.

Traces persist under `~/.phoenix` by default. A wiped working dir drops history.

## Where to look

1. Open project **`p8-summary`** (not only the home list).
2. Use the **Spans** / **Traces** table.
3. Set the **time range** (top of the project page) so yesterday and today both appear if needed.
4. The **filter bar** is above that table — not on the landing page. Prefer **Spans** first.

Official filter language: [Filter expressions](https://arize.com/docs/phoenix/tracing/how-to-tracing/filter-expressions).

## Live vs eval

Both paths share project `p8-summary` and span `summary.xai`. Distinguish them with **`metadata.source`**.

| | Live (`/v1/summary`) | Eval (golden harness) |
| --- | --- | --- |
| How to produce | Phoenix up → `npm start` → `POST /v1/summary` | Phoenix up → `EVAL_LIVE=1 npm run eval:golden` (optionally `-- <case-id>`) |
| `metadata.source` | `live` | `eval` |
| Extra attrs | — | `p8.case_id` (golden case id), `p8.run_id` (harness run id) |
| Also written | `data/summary-runs.jsonl` | `evals/runs/<runId>.jsonl` + `.html` |
| Flush | Process stays up; batch export has time | `provider.shutdown()` before exit (required) |

Open a span → **Attributes** / metadata and confirm `source` before trusting filters. Spans from before this tag was added have no `source` and won’t match either filter.

### Query only live

Spans or Traces filter bar:

```text
metadata['source'] == 'live'
```

```text
metadata['source'] == 'live' and status_code == 'ERROR'
```

```text
metadata['source'] == 'live' and latency_ms > 5000
```

File-side check: [query-logs-with-jq](query-logs-with-jq.md) on `data/summary-runs.jsonl` (`source` is always `live` there).

### Query only eval

```text
metadata['source'] == 'eval'
```

```text
metadata['source'] == 'eval' and name == 'summary.xai'
```

One golden case:

```text
metadata['source'] == 'eval' and attributes['p8.case_id'] == 'older-done-newer-firing'
```

One harness run (copy `p8.run_id` from a span, or from the JSONL `runId`):

```text
attributes['p8.run_id'] == '2026-11-18T13-00-00-000Z'
```

Failed / slow evals:

```text
metadata['source'] == 'eval' and status_code == 'ERROR'
```

```text
metadata['source'] == 'eval' and latency_ms > 10000
```

File-side: `evals/runs/*.jsonl` and `npm run eval:plots` → `evals/runs/trends.html`.

### Produce a pair to compare

1. Keep Phoenix running.
2. Live: `npm start`, then one `POST /v1/summary` for a known window.
3. Eval: `EVAL_LIVE=1 npm run eval:golden -- older-done-newer-firing`.
4. In Phoenix, filter `metadata['source'] == 'live'` then `== 'eval'`, or leave unfiltered and sort by time.
5. Same brief shape should appear in both; eval also has `p8.case_id`.

## Other sample filters (Spans tab)

Clear the bar between tries.

```text
span_kind == 'LLM'
```

```text
name == 'summary.xai'
```

```text
status_code == 'OK'
```

```text
status_code == 'ERROR'
```

```text
latency_ms > 5000
```

```text
llm.model_name == 'grok-4.7'
```

```text
metadata['prompt_version'] == 'summary-prompt-v2'
```

```text
'ROOM' in input.value
```

```text
token_count_total > 2000
```

## Other sample filters (Traces tab)

Needs a recent Phoenix with trace-level filter expressions.

```text
llm_span_count >= 1
```

```text
latency_ms > 5000
```

```text
error_count == 0
```

```text
metadata['prompt_version'] == 'summary-prompt-v2'
```

```text
metadata['source'] == 'eval'
```

```text
metadata['source'] == 'live'
```

## Golden dataset + CODE evaluators (experiment)

Mirrors the local harness for the first golden case (`must_mention` / `must_not` / overall `ok`).

```sh
# Phoenix must be running. Upsert dataset + run experiment (calls xAI).
npm run eval:phoenix

# Dataset only (no model call)
npm run eval:phoenix -- --dataset-only

# Other case id later (same meta/brief layout)
npm run eval:phoenix -- older-done-newer-firing
```

- Dataset name: **`p8-golden-summary`**
- Example `input.brief`, `output.must_mention` / `must_not` from `evals/golden/<id>/`
- Evaluators: `must_mention`, `must_not`, `ok` (same case-insensitive substring rules as `evals/run.ts`)
- UI: Datasets → `p8-golden-summary` → Examples / Experiments

This is a side-by-side learning path; the local golden harness remains the source of truth for CI.

## Notes

- Keep using [jq on the JSONL logs](query-logs-with-jq.md) for file-owned queries; Phoenix is the side-by-side UI for this experiment.
- If an eval run finishes but nothing new appears in Phoenix: confirm the collector was up, then that the process flushed/shut down spans. Widen the UI time range.
