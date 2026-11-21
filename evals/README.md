# Window summary evals

Golden regression for the one named inference call: frozen brief → paragraph. Unit tests stay offline with a fake summarizer; this folder freezes briefs and optionally scores live model output.

Design and why: [docs/p8-program/agentic/evals/golden-set.md](../docs/p8-program/agentic/evals/golden-set.md). Prompt versions: [docs/p8-program/agentic/prompts/summary/](../docs/p8-program/agentic/prompts/summary/).

## Layout

```text
evals/
  fixtures/           # rebuild a case (source for freeze)
  golden/
    <id>/
      brief.txt       # frozen user message
      meta.json       # prompt_version, must_mention, must_not, notes
  rubric.md           # dimensions for later LLM-as-judge / human scoring
  freeze-brief.ts
  run.ts
  plot-runs.ts        # trends HTML from runs/*.jsonl
  runs/               # live outputs: *.jsonl + *.html + trends.html (gitignored)
```

First case: `older-done-newer-firing` (from `test/journey.test.ts`). Human Done/reply timestamps are pinned inside a fixed window so the brief does not drift with wall clock.

## Commands

| Command | What it does |
| --- | --- |
| `npm run eval:freeze -- <id>` | Rebuild `golden/<id>/brief.txt` from its fixture |
| `npm run eval:golden` | List all cases (offline; no API call) |
| `npm run eval:golden -- <id>` | Same, but only that case |
| `EVAL_LIVE=1 npm run eval:golden` | Call xAI for all cases; check `must_mention` / `must_not`; write `runs/<timestamp>.jsonl` and `.html` |
| `EVAL_LIVE=1 npm run eval:golden -- <id>` | Live run for one case only |
| `npm run eval:plots` | Build `runs/trends.html` from all `runs/*.jsonl` (pass/fail, latency, tokens) |
| `npm run eval:phoenix` | Upsert Phoenix dataset `p8-golden-summary` + CODE experiment (needs Phoenix + `XAI_API_KEY`; `--dataset-only` skips the model) |
| `npm test` | Includes `test/eval-golden.test.ts` — frozen brief must still match the fixture |

Live runs also load `.env` from the repo root (same as `src/main.ts`). Optional: `XAI_MODEL` overrides the default model.

After a live run, open the printed `evals/runs/<runId>.html` path in a browser. Each case shows pass/fail, case notes, request params (`model`, `stream`, `reasoning_effort`, `temperature`), `must_mention` / `must_not` with hit/miss, latency, token usage (when the API returns it), the paragraph, and the brief. The JSONL row includes those fields plus `brief`, `paragraph`, `params`, and `usage` for scripting. Token field meanings: [token-usage.md](../docs/p8-program/agentic/token-usage.md).

For trends across runs (pass/fail, latency, prompt/completion/total and the total−(prompt+completion) gap), run `npm run eval:plots` and open `evals/runs/trends.html`.

## Adding a case

1. Add a fixture under `fixtures/` (or reuse an existing journey builder).
2. Register it in `freeze-brief.ts`.
3. Create `golden/<id>/meta.json` with `id`, `prompt_version` (match `SUMMARY_PROMPT_VERSION`), `must_mention`, `must_not`.
4. Run `npm run eval:freeze -- <id>`.
5. Extend the offline drift test if the case should stay locked in CI.
