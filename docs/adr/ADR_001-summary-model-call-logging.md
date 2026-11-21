# ADR 001 — Summary model-call logging

**Date:** 2026-11-17  
**Status:** Accepted  
**Related:** [token-usage](../concepts/token-usage.md), [Phoenix how-to](../how-to/phoenix-arize.md), [evals/README](../../evals/README.md)

---

## Context

P8’s first inference call is a single completion: brief → display paragraph (`/v1/summary` and live golden evals). Evals already write structured rows under `evals/runs/*.jsonl` (prompt version, model, request params, brief, output, latency, usage). Production still returns a paragraph and does not persist a model trace.

We need a **runtime** run log so a later reader can answer “why did this summary look like that?” without putting the paragraph on the alert / shift event log. Options considered were append-only NDJSON or a small SQLite table, with hosted tracers (LangSmith, Phoenix) deferred.

Candidates considered:

1. **Append-only NDJSON** (one file or dated files under `data/`, same row shape as eval JSONL)
2. **SQLite table** (second table in `data/p8.sqlite`, or a separate DB file), using the same `node:sqlite` stack as the alert log
3. **Hosted tracer** (LangSmith, Phoenix, etc.) as the primary store from day one

---

## Decision

1. **Store runtime model traces as append-only NDJSON**, separate from the alert event log. Default path: something like `data/summary-runs.jsonl` (env override later if needed). Do **not** write the summary paragraph into the alert / shift log.

2. **Row shape matches eval JSONL where practical:** prompt version, `params` (model, stream, reasoning_effort, temperature null = unset), window start/end, brief, output or error, latency, token usage, and `source: "live"` (evals remain their own files under `evals/runs/`).

3. **Query at this scale with file tools and shared scripts** (`jq`, small Node readers, and the step-5 plot path over structured runs). No dedicated query API required for v1.

4. **Defer hosted tracers** until volume, multi-step agent spans, or team sharing needs them. **Defer SQLite** for this log until SQL filters / joins become routine enough that NDJSON + scripts hurt.

---

## Rationale

### Why NDJSON first

- Eval harness already speaks JSONL; runtime rows can reuse the same fields and the same plot/reader work (plan 003 §5).
- Matches the intended ops habit: append-only traces, then light plots — not a second schema beside `openLog`.
- Volume for one local process and occasional `/v1/summary` calls is tiny; `tail` + `jq` is enough to inspect.
- Keeps model observability clearly **out of** the deterministic alert log (design boundary: log owns decisions; the model read is optional and display-oriented).

### Why not SQLite for v1

- Production already uses SQLite for **events**; putting LLM traces in the same DB invites mixing audit facts with model I/O unless carefully isolated.
- A separate SQLite file is fine later, but adds schema/migration surface without a query need we cannot meet with NDJSON yet.
- SQL wins when “last N where prompt_version = X and latency > Y and error is not null” becomes daily; that is a revisit trigger, not a starting requirement.

### Why not LangSmith / Phoenix first

- Single-shot completion, one operator, in-repo evals: a hosted product is heavier than the debugging loop we need now.
- Plan and next-steps already say a small append-only log is enough; upgrade when multi-step or sharing appears.

---

## Consequences

- Implementing plan 003 §4 means: on each `/v1/summary` (success, empty skip, API failure), append one NDJSON line with the shared params/usage shape from step 1.
- Operators inspect with `jq` / scripts; trends reuse the eval-run reader once live rows exist (or stay on eval JSONL until then).
- If the file grows awkward or filter-heavy workflows show up, revisit this ADR and consider SQLite or a hosted tracer — without rewriting the row fields if we kept schema parity.
- Alert log and report UI stay unchanged: paragraph remains display-only.
