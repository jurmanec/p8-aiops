# p8-aiops

On-call shift layer for facility reliability: ingest structured alerts from monitoring sources, thread them in Slack with human attention and escalation, and close the shift with a measured report.

**License:** [MIT](LICENSE)  
**Stack:** TypeScript · Node · SQLite · Slack · optional xAI window summary · Vitest · Phoenix (evals)

```text
  Alert producer (any source that can POST p8.alert)
        │
        ▼
  Intake  →  episode log  →  Slack / attention / escalation
        │
        ▼
  Shift report  (+ optional constrained summary under evals)
```

The machine is **domain-blind**. A simulated data-center hall is the first worked example, not the product identity.

---

## Quick start

```sh
cp .env.example .env   # fill Slack / xAI only if you need those paths
npm install
npm start              # http://127.0.0.1:8787
```

```sh
npm test
npm run check
```

Post a sample alert:

```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/alerts \
  -H "Content-Type: application/json" \
  -H "X-P8-Event-Id: $(jq -r .event_id docs/alert-samples/01.1-warning-firing.json)" \
  --data @docs/alert-samples/01.1-warning-firing.json
```

More curls and a shift close: [implementation how-to](docs/how-to/implementation-v1.md). Slack app setup: [slack/configuration](docs/slack/configuration.md). Env names: [`.env.example`](.env.example).

---

## Layout

| Path | Role |
|------|------|
| [`src/`](src/) | Process: intake, threads, Slack, escalation, report, summary |
| [`docs/contracts/`](docs/contracts/) | Alert intake (`p8.alert`) |
| [`docs/alert-samples/`](docs/alert-samples/) | Example `POST /v1/alerts` bodies |
| [`docs/design.md`](docs/design.md) · [`docs/roadmap.md`](docs/roadmap.md) | Version 1 decisions and sequence |
| [`docs/how-to/`](docs/how-to/) | Run, test, logs, Phoenix |
| [`docs/corpus/`](docs/corpus/) | Hall on-call reference for the demo |
| [`evals/`](evals/) | Golden briefs, live runs, plots |
| [`bruno/`](bruno/) | HTTP collection |
| [`test/`](test/) | Vitest |

---

## Out of scope

- Autonomously remediating plant or IT systems
- Generating telemetry or deciding when alerts fire (upstream monitors own that)
- Claiming live campus / production plant ownership (hall path is simulated)
- A generic chatbot; the optional model only drafts a shift-window paragraph under evaluation

Start with [alert intake](docs/contracts/alert-intake.md), [design](docs/design.md), and [system shape](docs/concepts/system-shape.md).
