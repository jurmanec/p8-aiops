
## start
```sh
npm start
```

## inject data
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/alerts \
  -H "Content-Type: application/json" \
  -H "X-P8-Event-Id: $(jq -r .event_id docs/alert-samples/01.1-warning-firing.json)" \
  --data @docs/alert-samples/01.1-warning-firing.json
```
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/alerts \
  -H "Content-Type: application/json" \
  -H "X-P8-Event-Id: $(jq -r .event_id docs/alert-samples/03.1-critical-firing.json)" \
  --data @docs/alert-samples/03.1-critical-firing.json
```

## call threads api
curl -sS http://127.0.0.1:8787/v1/threads

## record a response on an open critical thread
Post `03.1-critical-firing.json` first. A warning thread rejects this.

```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"alert_key":"mon-dc-building:job-room-01:2c874b5443891358","action":"WORKING_ON_IT","note":"checking the room"}'
```

## escalation
The running process checks every few seconds. Fifteen minutes after an unanswered critical alert was stored, the thread gains `"escalation": { "next": "secondary-oncall" }`.

## close a shift
`start` and `end` bound the rows by the time they were stored. The response is the report. The model is not called.

```sh
curl -sS -X POST http://127.0.0.1:8787/v1/shifts \
  -H "Content-Type: application/json" \
  -d '{"start":"2026-11-15T14:00:00.000Z","end":"2026-11-15T22:00:00.000Z"}'
```
## sample workflow 1 - human resolves critical
Critical -> Human ack -> Human resolves with note -> Close shift
**critical alert fires**
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/alerts \
  -H "Content-Type: application/json" \
  -H "X-P8-Event-Id: $(jq -r .event_id docs/alert-samples/03.1-critical-firing.json)" \
  --data @docs/alert-samples/03.1-critical-firing.json
```
**human acknowledges critical alert** 
- Human gives a text note
- Timer starts for followup with human
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"alert_key":"mon-dc-building:job-room-01:2c874b5443891358","action":"WORKING_ON_IT","note":"checking the room"}'
```
**Human closes loop with DONE button selection**
- Human selects DONE button
- Human message is updated
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"alert_key":"mon-dc-building:job-room-01:2c874b5443891358","action":"DONE","note":"loop is closed"}'
```
**Resolved alert message fires**
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/alerts \
  -H "Content-Type: application/json" \
  -H "X-P8-Event-Id: $(jq -r .event_id docs/alert-samples/04.1-critical-resolved.json)" \
  --data @docs/alert-samples/04.1-critical-resolved.json
```
**close shift**
```sh
curl -sS -X POST http://127.0.0.1:8787/v1/shifts \
  -H "Content-Type: application/json" \
  -d '{"start":"2026-11-15T14:00:00.000Z","end":"2026-11-16T22:00:00.000Z"}'
```

## sample workflow 1 - human resolves critical with updates > 1
Critical -> Human ack -> Human resolves with note -> Close shift
**inject**
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/alerts \
  -H "Content-Type: application/json" \
  -H "X-P8-Event-Id: $(jq -r .event_id docs/alert-samples/03.1-critical-firing.json)" \
  --data @docs/alert-samples/03.1-critical-firing.json
```
**human acknowledges critical alert** 
Timer starts for followup with human
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"alert_key":"mon-dc-building:job-room-01:2c874b5443891358","action":"WORKING_ON_IT","note":"checking the room"}'
```
**Human makes update**
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"alert_key":"mon-dc-building:job-room-01:2c874b5443891358","action":"WORKING_ON_IT","note":"the loop can be closed"}'
```
**close shift**
```sh
curl -sS -X POST http://127.0.0.1:8787/v1/shifts \
  -H "Content-Type: application/json" \
  -d '{"start":"2026-11-15T14:00:00.000Z","end":"2026-11-15T22:00:00.000Z"}'
```
## sample workflow 2 - only warning
**inject**
```sh
curl -sS -D - -o /dev/null -X POST http://127.0.0.1:8787/v1/alerts \
  -H "Content-Type: application/json" \
  -H "X-P8-Event-Id: $(jq -r .event_id docs/alert-samples/01.1-warning-firing.json)" \
  --data @docs/alert-samples/01.1-warning-firing.json
```
**close shift**
```sh
curl -sS -X POST http://127.0.0.1:8787/v1/shifts \
  -H "Content-Type: application/json" \
  -d '{"start":"2026-11-15T14:00:00.000Z","end":"2026-11-15T22:00:00.000Z"}'
```
