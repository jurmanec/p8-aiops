# Roadmap

Draft, 2026-11-15 (public wording refreshed 2026-11-21). The core is a domain-blind decision log. Version 1 is one team and one shift. Decisions: [design](design.md). Alerts arrive only through [alert intake](contracts/alert-intake.md).

The hyperscaler data-center hall is the first corpus that exercises the log. Enterprise IT, data-center IT, and a plant later use the same rules. `team` is an opaque key to a contact list. Version 1 has one list.

Paging and escalation are rules over the log. The model is asked only to write the shift report, and that step can be skipped.

Phase 1 proof: an upstream facility path feeds a monitor, the monitor posts `p8.alert` events here, and this process writes a shift report for one planned outage on that building corpus.

## 1. Intake

Accept `POST /v1/alerts` for `p8.alert` 0.2 and 0.3. Check the body against the samples in [alert-samples](alert-samples/README.md). Save a valid event and answer `202`. Answer `200` when `event_id` is already stored. Answer `400` when the body does not match. Dedup by `event_id`.

Add one fixture whose tags are not a hall: a different `team`, no `asset_id`, and the same accept, reject, and dedup results.

Versions 0.2 and 0.3 were accepted 2026-11-15. A 0.3 body does not need `monitor_id` or `time_series_tags`. It needs `labels`.

## 2. Thread

Group events by `alert_key`. Decisions use `transition`, `severity`, `team`, whether `manual_url` is present, `alert_key`, `event_id`, and the timestamps. `summary`, `details`, and tag names are stored and shown.

- A warning `FIRING` is recorded. Nobody is contacted.
- A critical `FIRING` stays open until a person owns it.
- No severity is recorded. Nobody is contacted.
- A `RESOLVED` from the producer attaches to the same `alert_key` and records that the condition cleared.
- A `RESOLVED` that arrives before `FIRING` is stored. Nobody is contacted. A later `FIRING` attaches to the same `alert_key`.

A person marking the issue done is a separate fact from producer `RESOLVED`. Record both.

## 3. Human response

The first adapter into the log is a message with buttons. The buttons are `WORKING_ON_IT` and `IGNORE_IT`. An optional note is stored with the thread and is never parsed for a decision. The message includes `manual_url` when the event has one, and says when it does not.

## 4. Escalation

`team` selects the contact list. When nobody answers a critical alert, the clock contacts the next person on that list. The thread stays one alert. Version 1 has one list, one rung, and one clock.

## 5. Shift report

Close one shift and write the report from the stored record: what fired, severity, whether a manual link was present, who answered, how long that took, what was still open, and any escalation. The model writes inside a fixed schema and can be skipped. The record remains.

## 6. Slack proxy

Post the firing as the top-level message. Reply in that thread for a critical alert. On `RESOLVED`, edit the parent and add the recovery reply. Posting is off until `SLACK_POST=1`. Button presses wait until Slack can reach this process.

## 7. Planned outage

Walk one planned outage on the building corpus with live alert intake and keep the shift report from that run. That is the first end-to-end proof on that corpus.

## Out of scope

P8 does not generate telemetry, decide when an alert fires, or own the upstream monitor or plant path.
