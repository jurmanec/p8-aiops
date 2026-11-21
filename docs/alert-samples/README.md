# Alert intake samples (ROOM-01)

Example `POST /v1/alerts` JSON bodies for the [`p8.alert`](../contracts/alert-intake.md) contract, shaped like a facility **ROOM-01** series and a building monitor used in local demos.

Normative field rules: [alert intake](../contracts/alert-intake.md).

## Scenario

| File | Transition | Series (`alarm_severity`) | Page severity |
|------|------------|---------------------------|---------------|
| [`01.1-warning-firing.json`](01.1-warning-firing.json) | `FIRING` | warning, contract 0.3 | warning |
| [`02.1-warning-resolved.json`](02.1-warning-resolved.json) | `RESOLVED` | warning, contract 0.3 | warning |
| [`03.1-critical-firing.json`](03.1-critical-firing.json) | `FIRING` | critical, contract 0.3 | critical |
| [`04.1-critical-resolved.json`](04.1-critical-resolved.json) | `RESOLVED` | critical, contract 0.3 | critical |
| [`05-service-firing.json`](05-service-firing.json) | `FIRING` | service / check (no hall) | warning |
| [`06-general-firing.json`](06-general-firing.json) | `FIRING` | 0.3 `labels` / `identity_tags` | critical |

`05-service-firing.json` is not a building alert. Its `team` is `payments-oncall`, and its tags have no `asset_id`. Intake accepts it under the 0.2 rules.

`01.1` through `04.1` are the ROOM-01 samples on contract 0.3. Each keeps the `alert_key` and the firing or resolve facts from the earlier 0.2 sample it replaced. `labels` replaces `time_series_tags`. The monitor, job, and metric facts sit in `details`.

`06-general-firing.json` is contract 0.3. It has no `monitor_id`, `job_id`, or `time_series_tags`. `labels` is the tag map. `identity_tags` is the grouping map. Producer facts would sit in `details`.

Assumptions baked into the samples:

- One job (`job-room-01`) writes `row_count` with identity tags `asset_id` / `hall_id` and condition tag `alarm_severity` (path pick from alarms).
- Warning and critical are **different series** → **different `alert_key`s**.
- Matching FIRING / RESOLVED share the same `alert_key` and tag fields; RESOLVED sets `resolved_at` and `details.value` to `0`.
- `alert_key` is opaque to P8 (producer-built).
- Optional `condition_tag_keys` / `identity_tags` are included so P8 can try grouping.
- `status` is omitted (query already targets faulted rows / not used as a series tag here).

## Example request

```bash
curl -sS -X POST "$P8_ALERT_URL/v1/alerts" \
  -H "Content-Type: application/json" \
  -H "X-P8-Event-Id: $(jq -r .event_id docs/alert-samples/01.1-warning-firing.json)" \
  --data @docs/alert-samples/01.1-warning-firing.json
```

Expect `202 Accepted` (or `200 OK` on replay of the same `event_id`).
