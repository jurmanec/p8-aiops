import type { AlertLog } from "./log.ts";
import { projectThreads } from "./thread.ts";

/** One list and one rung for version 1. `team` does not select a different person yet. */
export const ESCALATION_WAIT_MS = 15 * 60 * 1000;
export const NEXT_CONTACT = "secondary-oncall";

export function escalationEventId(alertKey: string, firingEventId: string): string {
  return `escalation:${alertKey}:${firingEventId}`;
}

export function runEscalations(log: AlertLog, now: Date): string[] {
  const wrote: string[] = [];
  for (const thread of projectThreads(log.list())) {
    if (thread.attention !== "open" || thread.escalation || thread.done) continue;
    if (now.getTime() - Date.parse(thread.openedAt) < ESCALATION_WAIT_MS) continue;
    const result = log.save(
      escalationEventId(thread.alertKey, thread.firingEventId),
      JSON.stringify({ alert_key: thread.alertKey, next: NEXT_CONTACT }),
      now.toISOString(),
    );
    if (result === "saved") wrote.push(thread.alertKey);
  }
  return wrote;
}
