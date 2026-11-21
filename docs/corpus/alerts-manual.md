# Hall alerts

On-call reference for the facility demo (scenario 002). One entry per series P8 can open. This page says what to do next and where to look in the thin cloud copy and local historian.

The plant path stores alarm severity as `warning` or `error` on the snapshot. P8 maps plant `error` to page severity `critical`. When an alert says `critical`, the plant item to find has `alarms[].severity` of `error`, not the word `critical`.

## Where to look

The cloud copy is the DynamoDB table `p3-cell-telemetry-dev-samples` in `us-east-1`. The partition key attribute is `pk` and its value is the asset id (`CRAH-01`, `ROOM-01`, or `UPS-01`). The sort key attribute is `sk`, the snapshot timestamp with nine fractional digits, for example `2026-11-13T16:36:00.716143294Z`. Newest items are at the end of that order. Read `status`, `reading`, `unit`, and `alarms` (`code`, `severity`, `message`).

Replace the asset id to query another unit. This returns the latest five items for `ROOM-01`:

```bash
aws dynamodb query \
  --region us-east-1 \
  --table-name p3-cell-telemetry-dev-samples \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk":{"S":"ROOM-01"}}' \
  --no-scan-index-forward \
  --limit 5
```

The local picture is Grafana at [http://localhost:3000](http://localhost:3000), dashboard **Facility historian**. Open the **Reading** panel (one line per asset; `CRAH-01` and `ROOM-01` are °C, `UPS-01` is percent) and the **Status** panel (green `RUNNING`, red `FAULTED`). Set the time range to the demo window. The board has every snapshot. The table has the thinner copy: about one item in five while the asset is healthy, and every snapshot once an alarm is present.

Confirm fields on the latest thin-copy item (`status`, `reading`, `unit`, `alarms`) and on the historian panels below. Cascade order in this scenario: short UPS battery episode, then CRAH supply-air high, then room warning, then room error.

## Alerts

| Alarm | Asset | Plant severity | P8 severity | Note |
|---|---|---|---|---|
| `UPS_ON_BATTERY` | `UPS-01` | `warning` | `warning` | Utility sag; clears ~30 s |
| `COOLING_SUPPLY_HIGH` | `CRAH-01` | `warning` | `warning` | Supply air steps to 28 °C; stays |
| `ROOM_TEMP_HIGH` | `ROOM-01` | `warning` | `warning` | Hall at 27 °C |
| `ROOM_TEMP_HIGH` | `ROOM-01` | `error` | `critical` | Hall at 32 °C (page as critical) |

`ROOM_TEMP_HIGH` is one alarm code and two series. The warning series goes quiet when the plant replaces `warning` with `error`. The error series is the one P8 shows as `critical`.

### UPS_ON_BATTERY, warning

`UPS-01` is on battery after a utility sag. The message is "UPS on battery after a utility sag." Load stays 40 percent. This is not the cooling fault. `CRAH-01` and `ROOM-01` are still healthy while it is on battery.

Confirm the latest item for `pk` `UPS-01`: `status` `FAULTED`, `reading` 40, `unit` percent, alarm `UPS_ON_BATTERY` with severity `warning`. On **Facility historian**, the UPS line stays near 40 and **Status** is red only for that short stretch.

It should clear in about 30 seconds. Status returns to `RUNNING` and `alarms` is empty. Confirm the load is still 40 percent. If the cabinet is still on battery after that half minute, it is no longer this scenario.

### COOLING_SUPPLY_HIGH, warning

`CRAH-01` is no longer holding supply-air setpoint. The reading steps from 16 °C to 28 °C and stays there. The message is "Supply air above setpoint." This scenario does not clear the alarm. The page stays a warning. The severe page is the room at 32 °C, not a second alarm on this unit.

Confirm the latest item for `pk` `CRAH-01`: `status` `FAULTED`, `reading` 28, `unit` `C`, alarm `COOLING_SUPPLY_HIGH` with severity `warning`. On **Facility historian**, the CRAH line steps to 28 °C and stays there. Then watch the room line on the same **Reading** panel. A room warning follows at about six minutes, and a room error at about nine.

### ROOM_TEMP_HIGH, warning

The hall has left the recommended band. `ROOM-01` steps from 22 °C to 27 °C. The message is "Hall temperature above recommended limit." The hall has not reached the allowable ceiling. Stay with the cooling unit. In this scenario `CRAH-01` is already blowing 28 °C supply air.

Confirm the latest item for `pk` `ROOM-01`: `status` `FAULTED`, `reading` 27, `unit` `C`, alarm `ROOM_TEMP_HIGH` with severity `warning`. On **Facility historian**, the room line is at 27 °C and the CRAH line is already at 28 °C. This series ends when a later item carries the same code at severity `error`.

### ROOM_TEMP_HIGH, error

The hall is at the allowable ceiling. `ROOM-01` steps from 27 °C to 32 °C. The code stays `ROOM_TEMP_HIGH`. The plant severity becomes `error`. The message is "Hall temperature at allowable limit." P8 shows this series as `critical`. The cooling unit is still in warning at 28 °C and does not recover in this scenario.

Confirm the latest item for `pk` `ROOM-01`: `status` `FAULTED`, `reading` 32, `unit` `C`, alarm `ROOM_TEMP_HIGH` with severity `error`. Do not search the item for `critical`. On **Facility historian**, the room line is at 32 °C and **Status** for the room stays red. The warning entry for this same code no longer matches the live item.
