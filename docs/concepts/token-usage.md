# Token usage

Noted 2026-11-17. How live window-summary evals record model tokens. Runtime parse: `tokenUsageOf` in `src/summary.ts`. Harness: [evals/README.md](../../../evals/README.md).

Production `/v1/summary` writes the same `usage` / `params` shape to `data/summary-runs.jsonl` (see [ADR_001](../adr/ADR_001-summary-model-call-logging.md)). Cost dashboards and richer eval cost plots are not in this version.

## What we store

Each live golden run (`EVAL_LIVE=1`) writes a `usage` object on the JSONL row and shows the same numbers on the HTML card:

| Field | API source | Meaning |
| --- | --- | --- |
| `prompt` | `usage.prompt_tokens` | Tokens in the request: system prompt + user brief |
| `completion` | `usage.completion_tokens` | Tokens in the visible reply paragraph |
| `total` | `usage.total_tokens` when present; otherwise `prompt + completion` | All-in figure from the provider |

Display form: `1969 prompt + 91 completion = 2524 tokens`.

## Prompt vs completion vs total

Prompt is usually large: the frozen system prompt (`SUMMARY_PROMPT`) and the full brief are counted every call. Completion stays small for a one-paragraph summary.

**`prompt + completion` may not equal `total`.** When the API returns `total_tokens`, we keep that value. The gap (for example 1969 + 91 = 2060 but total 2524) is often other billed or internal tokens—commonly **reasoning** when the call uses `reasoning_effort`—that are not split into the prompt/completion fields we display. Treat **total** as the all-in count; treat prompt and completion as the visible input/output split.

## Where it appears

- Terminal line on a live eval
- `evals/runs/<runId>.jsonl` → `usage` (and `params` for model / `reasoning_effort` / sampling)
- `evals/runs/<runId>.html` next to latency
- `data/summary-runs.jsonl` (or `P8_SUMMARY_RUNS`) on each live `/v1/summary` attempt

If the provider omits `usage`, `usage` is `null` and the UI shows latency only. Request params are still recorded even when usage is missing.
