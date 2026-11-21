# Query logs with jq

Two append-only JSONL logs. Alert events stay in SQLite (`data/p8.sqlite`); these are the model / eval traces. Decision: [ADR_001](../adr/ADR_001-summary-model-call-logging.md). Tokens: [token-usage](../concepts/token-usage.md).

| Log | Path | Written by |
| --- | --- | --- |
| Live summary | `data/summary-runs.jsonl` (or `P8_SUMMARY_RUNS`) | `/v1/summary` |
| Golden evals | `evals/runs/<runId>.jsonl` | `EVAL_LIVE=1 npm run eval:golden` |

Needs [jq](https://jqlang.org/). Run from the repo root.

## Live summary runs

```sh
# last few
tail -n 20 data/summary-runs.jsonl | jq .

# compact: time, model, latency, tokens, skip/error
tail -n 20 data/summary-runs.jsonl | jq '{
  runId, model, prompt_version, latencyMs,
  skipped, error,
  usage,
  paragraph: (.paragraph | .[0:80])
}'

# errors and skips only
jq 'select(.error != null or .skipped != null)' data/summary-runs.jsonl

# one prompt version
jq 'select(.prompt_version == "summary-prompt-v2")' data/summary-runs.jsonl

# token gap (often reasoning)
jq 'select(.usage != null) | {
  runId,
  prompt: .usage.prompt,
  completion: .usage.completion,
  total: .usage.total,
  gap: (.usage.total - .usage.prompt - .usage.completion)
}' data/summary-runs.jsonl

# request params
jq '{runId, params}' data/summary-runs.jsonl
```

## Eval runs

One file per live harness run. Trends HTML: `npm run eval:plots`.

```sh
# all rows across files
jq -s 'add' evals/runs/*.jsonl 2>/dev/null | jq .

# or stream every line
cat evals/runs/*.jsonl | jq .

# pass / fail
cat evals/runs/*.jsonl | jq '{runId, id, ok, prompt_version, model, latencyMs}'

# failures only
cat evals/runs/*.jsonl | jq 'select(.ok == false)'

# by case
cat evals/runs/*.jsonl | jq 'select(.id == "older-done-newer-firing")'

# latency + usage when present
cat evals/runs/*.jsonl | jq '{
  runId, id, ok, latencyMs,
  usage,
  gap: (if .usage then (.usage.total - .usage.prompt - .usage.completion) else null end)
}'

# one run file
jq . evals/runs/2026-11-17T21-30-21-655Z.jsonl
```

Older eval rows may omit `usage` or `params`; `select(.usage != null)` skips those.

## Tips

```sh
# pretty one object from stdin
echo '{"a":1}' | jq .

# raw string (no quotes)
jq -r .paragraph data/summary-runs.jsonl | tail -n 1

# count lines / objects
wc -l data/summary-runs.jsonl
jq -s 'length' data/summary-runs.jsonl
```
