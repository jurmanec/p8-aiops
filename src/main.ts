import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runEscalations } from "./escalation.ts";
import { openLog } from "./log.ts";
import { registerPhoenix } from "./phoenix.ts";
import { createIntakeServer } from "./server.ts";
import { openSummaryRunLog, summaryRunsPath } from "./summary-run-log.ts";

loadEnvFile(".env");
registerPhoenix();

const dbPath = process.env.P8_DB ?? "data/p8.sqlite";
const runsPath = summaryRunsPath(process.env);
const port = Number(process.env.PORT ?? 8787);

mkdirSync(dirname(dbPath), { recursive: true });
const log = openLog(dbPath);
const summaryRunLog = openSummaryRunLog(runsPath);
const server = createIntakeServer(log, { summaryRunLog });

server.listen(port, "127.0.0.1", () => {
  console.log(`intake listening on http://127.0.0.1:${port}`);
});

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split === -1) continue;
    const key = trimmed.slice(0, split).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(split + 1).trim();
  }
}

setInterval(() => {
  try {
    runEscalations(log, new Date());
  } catch (error) {
    console.error(error);
  }
}, 5_000);
