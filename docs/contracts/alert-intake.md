# Alert intake (`p8.alert`)

Structured alert events that **any monitoring or industry alerting source** can POST into this process. P8 stays **domain-blind**: it does not branch on plant tag names, label keys, or producer-specific fields in `details`.

This file is the **public consumer-facing** contract for the alert seam (program id **C3**). Program board index: keep versions and producer notes there; change the envelope here.

Samples: [alert-samples](../alert-samples/README.md). Behavior after intake: [design](../design.md).

This process accepts contract versions **0.2** and **0.3**. Prefer **0.3** for new producers.

## Transitions

One event per state change: `FIRING` when a series enters alert, `RESOLVED` when it clears. Matching fire and resolve share the same `alert_key`. No event for an initial healthy state.

## Transport

- **Request:** `POST /v1/alerts` with one JSON body.
- **Headers:** `Content-Type: application/json`; `X-P8-Event-Id: <event_id>` (same value as in the body).
- **Responses:**
  - `202 Accepted` — received and saved
  - `200 OK` — duplicate `event_id` already stored
  - `400` — body does not match the contract
  - `5xx` / timeout — producer may retry
- **Dedup:** by `event_id`.
- **Not in v1:** request signing, batching, brokers, callbacks, polling.

## Version 0.3 (preferred)

`labels` is the tag map. Producer-specific facts (monitor id, metric, threshold, window, and so on) belong in `details`. Slack channel and message ids are not fields. The producer builds `alert_key`; P8 only tests it for equality.

```json
{
  "contract": "p8.alert",
  "version": "0.3",
  "source": "alertmanager",
  "event_id": "am:fingerprint:2026-11-15T18:02:11.000Z:firing",
  "alert_key": "am:3b1c9e0a4d77",
  "transition": "FIRING",
  "emitted_at": "2026-11-15T18:02:11.000Z",
  "fired_at": "2026-11-15T18:02:00.000Z",
  "resolved_at": null,
  "severity": "critical",
  "team": "facility-ops",
  "manual_url": "https://example.test/runbook",
  "summary": "CRAH-01 supply air high",
  "labels": { "alertname": "SupplyAirHigh", "asset": "CRAH-01" },
  "identity_tags": { "asset": "CRAH-01" },
  "details": {}
}
```

Facility-shaped example (monitor facts in `details`):

```json
{
  "contract": "p8.alert",
  "version": "0.3",
  "source": "example-monitor",
  "event_id": "11111111-1111-4111-8111-111111111101",
  "alert_key": "mon-dc-building:job-room-01:a0f87b2057b3eb10",
  "transition": "FIRING",
  "emitted_at": "2026-11-14T22:05:42.335Z",
  "fired_at": "2026-11-14T22:05:42.335Z",
  "resolved_at": null,
  "severity": "warning",
  "team": "facility-ops",
  "manual_url": "https://example.test/runbooks/room-env",
  "summary": "row_count 1 ≥ threshold 1 for 1 consecutive point",
  "labels": {
    "alarm_severity": "warning",
    "asset_id": "ROOM-01",
    "hall_id": "HALL-01"
  },
  "identity_tags": {
    "asset_id": "ROOM-01",
    "hall_id": "HALL-01"
  },
  "details": {
    "monitor_id": "mon-dc-building",
    "monitor_name": "Data Center Building Monitor",
    "job_id": "job-room-01",
    "condition_tag_keys": ["alarm_severity"],
    "metric_name": "row_count",
    "value": 1,
    "threshold": 1,
    "consecutive_points": 1,
    "window_start": "2026-11-13T22:05:42.335Z",
    "window_end": "2026-11-14T22:05:42.335Z"
  }
}
```

On **RESOLVED:** same `alert_key`; set `resolved_at`; keep original `fired_at`. Send the same `labels` and `identity_tags` when the producer has them.

### Fields (0.3)

| Field | Required | Type | Meaning |
|---|---|---|---|
| `contract` | yes | string | Always `p8.alert` |
| `version` | yes | string | `0.3` |
| `event_id` | yes | string | Unique per delivery; P8 dedupes |
| `alert_key` | yes | string | Stable from fire through resolve. Opaque to P8 (equality only) |
| `transition` | yes | string | `FIRING` or `RESOLVED` |
| `emitted_at` | yes | string | When the producer sent the event (UTC `Z`) |
| `fired_at` | yes | string | When the alert entered the firing state |
| `resolved_at` | on RESOLVED | string or null | When it cleared; null on FIRING |
| `source` | no | string | Emitting system when set |
| `severity` | no | string or null | `critical` \| `warning` \| `info` when set |
| `team` | no | string | May be empty or absent |
| `manual_url` | no | string | May be empty or absent |
| `summary` | no | string | One readable line; do not parse |
| `labels` | yes | object | String map for display. May be empty. Do not branch on key names |
| `identity_tags` | no | object | Grouping map when the producer sends it |
| `details` | no | object | Opaque producer facts. Store and display; never branch |

## Version 0.2 (still accepted)

Requires `monitor_id`, `job_id`, and `time_series_tags`. Tag map is `time_series_tags` instead of `labels`. Same transport and transitions.

```json
{
  "contract": "p8.alert",
  "version": "0.2",
  "event_id": "8b1f3c2e-…",
  "alert_key": "mon-123:job-456:a1b2c3d4e5f67890",
  "transition": "FIRING",
  "emitted_at": "2026-11-14T22:05:42.335Z",
  "fired_at": "2026-11-14T22:05:42.335Z",
  "resolved_at": null,
  "severity": "warning",
  "team": "facility-ops",
  "manual_url": "https://example.test/runbook",
  "monitor_id": "mon-123",
  "monitor_name": "Data Center Building Monitor",
  "job_id": "job-456",
  "time_series_tags": {
    "asset_id": "ROOM-01",
    "hall_id": "HALL-01",
    "alarm_severity": "warning"
  },
  "condition_tag_keys": ["alarm_severity"],
  "identity_tags": {
    "asset_id": "ROOM-01",
    "hall_id": "HALL-01"
  },
  "summary": "row_count 1 ≥ threshold 1 for 1 consecutive point",
  "details": {
    "metric_name": "row_count",
    "value": 1,
    "threshold": 1,
    "consecutive_points": 1,
    "window_start": "2026-11-13T22:05:42.335Z",
    "window_end": "2026-11-14T22:05:42.335Z"
  }
}
```

There is **no** top-level `asset_id`. If present, it is only a key inside tags / `labels`.

## Consumer note — severity update

An open `alert_key` plus a later `FIRING` with a **changed** `severity` (same series, usually the original `fired_at`) is a **severity update**: same episode / Slack parent, not a new top-level alert. Same-severity repeats while open are quiet. Detail: [attention and condition](../concepts/p8-app/attention-and-condition.md), [design](../design.md).

## Out of scope for this contract

- How P8 routes missing severity, resolve-before-fire, Slack posting, or the shift report ([design](../design.md))
- How a producer builds `alert_key` or maps native severity onto the enum
- Slack `channel` / `ts` on the payload (this process owns the parent message when posting)
