# Design

Initial note, 2026-11-15 (public wording refreshed 2026-11-21). Version 1 decisions. Sequence: [roadmap](roadmap.md). Shape: [system shape](concepts/system-shape.md). Alerts arrive only through [alert intake](contracts/alert-intake.md) (`p8.alert`).

## Core

P8 is a deterministic state machine and an audit log. The same event and the same button always take the same path. The log is the record: intake appends each alert event, a button appends the person's answer, and the escalation clock appends its step. Current thread state is a projection of that log. The model reads the log when it writes the shift report, and that step can be skipped. The log remains.

The machine is domain-blind. A hyperscaler data-center hall is the first corpus that exercises it. Enterprise IT, data-center IT, and a plant later use the same rules.

## Stack

TypeScript, one local process, SQLite. The log is one table of events, deduped on `event_id`. It lives in this repo and is not the upstream monitor's database. This process is not a Next.js app.

Intake accepts `p8.alert` **0.2** and **0.3**. Decisions use the envelope fields. `labels` and `identity_tags` are stored and shown. The ROOM-01 samples, the non-hall fixture, and `06-general-firing.json` are the tests. See [alert-samples](alert-samples/README.md).

## What a decision may use

`transition`, `severity`, `team`, whether `manual_url` is present, `alert_key`, `event_id`, and the timestamps on the event. `summary`, `details`, and tag names are stored and shown. `team` is an opaque key to a contact list. Version 1 has one list.

- A warning `FIRING` is recorded. Nobody is contacted.
- A critical `FIRING` stays open until a person owns it.
- No severity is recorded. Nobody is contacted.
- A `RESOLVED` from the producer on the same `alert_key` records that the condition cleared.
- A `RESOLVED` that arrives before `FIRING` is stored and does not post. A later `FIRING` opens a new episode and posts.
- A person marking the issue done is a separate fact from producer `RESOLVED`. Record both. `DONE` does not clear the condition.

Intake answers `202` when it saves an event, `200` when `event_id` is already stored, and `400` when the body does not match.

## Human adapter

For an onboarded team this process posts the alert. The top-level Slack message is the firing: severity, monitor name, state, identity, condition (when present), detail, window, and manual link. A critical firing also gets a thread reply with `WORKING_ON_IT`, `IGNORE_IT`, and `DONE`. The buttons read Non actionable, In progress, and Done, and they stay. The reply shows `State:` and the current state in code text. Each new click is also posted in the thread as the state and the name. A warning gets the parent and no reply. A missing severity is recorded and not posted. A firing posts a new parent when that series is not already open, including after an earlier resolve. While the series is still open, a later `FIRING` with a **changed** severity edits that same parent and appends a severity thread line; it does not open a second top-level message. Buttons appear on the first critical for that episode; after Done, a later return to critical asks the person to reconsider attention. Same-severity repeats stay quiet. Detail: [attention and condition](concepts/p8-app/attention-and-condition.md). On `RESOLVED`, that parent is edited in place and a short recovery reply is added. The original window stays. Duration is `resolved_at` minus `fired_at`. The parent timestamp stays after resolve. `DONE` does not clear the condition. A note is stored and never parsed. A repeated click on the current firing, with the same action, note, and person, is kept once. A click from an earlier firing is not that repeat. A different click is appended, and the latest one is the current state. The report uses the closing note when that latest click is `DONE`. Posting waits on `SLACK_POST=1`.

## Escalation

Version 1 has one contact list, one rung, and one clock. `team` does not select a different person yet. When a critical thread is still open 15 minutes after that firing was stored, the clock appends one escalation to the log for `secondary-oncall`. The thread stays the same alert. A button can still be recorded after that. A warning, an owned thread, a thread the person marked done, and a resolve that arrived first are not escalated.

## Shift

One shift is a window from a start timestamp to an end timestamp. Closing it writes a report into the log. The report includes each thread whose first row falls in that window: what fired, **peak** severity for the episode (highest seen; the alerts timeline shows the path), whether a manual link was present, the button and note if someone answered, the latest closing note, how long that answer took, what was still open, any escalation, and a discrepancy when `DONE` and producer `RESOLVED` disagree. Rows received at or after the end are left out. The model is skipped. The stored report remains if the same window is closed again.

## Ops notes (not product backlog)

Which model writes the optional summary paragraph. A durable public `https` host so Slack can reach `POST /slack/interactions` and `POST /slack/events`. A follow-up timer after the first button is not in version 1.

## Out of scope

P8 does not generate telemetry, decide when an alert fires, or own the upstream monitor or plant path. It consumes structured alerts only through [alert intake](contracts/alert-intake.md).
