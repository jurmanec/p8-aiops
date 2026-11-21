import { DatabaseSync } from "node:sqlite";

export type StoredEvent = {
  eventId: string;
  body: string;
  receivedAt: string;
};

export type AlertLog = {
  save(eventId: string, body: string, receivedAt: string): "saved" | "duplicate";
  replace(eventId: string, body: string, receivedAt: string): void;
  get(eventId: string): StoredEvent | undefined;
  list(): StoredEvent[];
  close(): void;
};

export function openLog(path: string): AlertLog {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare(
    "INSERT INTO events (event_id, body, received_at) VALUES (?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE events SET body = ?, received_at = ? WHERE event_id = ?",
  );
  const select = db.prepare(
    "SELECT event_id, body, received_at FROM events WHERE event_id = ?",
  );
  const list = db.prepare(
    "SELECT event_id, body, received_at FROM events ORDER BY received_at, event_id",
  );

  return {
    save(eventId, body, receivedAt) {
      try {
        insert.run(eventId, body, receivedAt);
        return "saved";
      } catch (error) {
        if (isUniqueViolation(error)) return "duplicate";
        throw error;
      }
    },
    replace(eventId, body, receivedAt) {
      const result = update.run(body, receivedAt, eventId);
      if (Number(result.changes) === 0) insert.run(eventId, body, receivedAt);
    },
    get(eventId) {
      const rows = select.all(eventId) as Array<{
        event_id: string;
        body: string;
        received_at: string;
      }>;
      const row = rows[0];
      if (!row) return undefined;
      return { eventId: row.event_id, body: row.body, receivedAt: row.received_at };
    },
    list() {
      const rows = list.all() as Array<{
        event_id: string;
        body: string;
        received_at: string;
      }>;
      return rows.map((row) => ({
        eventId: row.event_id,
        body: row.body,
        receivedAt: row.received_at,
      }));
    },
    close() {
      db.close();
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    (error as { errcode: unknown }).errcode === 1555
  );
}
