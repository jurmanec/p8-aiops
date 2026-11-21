import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { AlertLog } from "./log.ts";
import { buildShiftReport, closeShift, validateShift } from "./report.ts";
import { applyHumanResponse, validateResponse } from "./response.ts";
import { clickEpisode, deliverSlack, liveSlack, liveUserLookup, recordReply, resolveReplyActor, showClick, slackActor, slackButton, slackChallenge, slackConfig, slackPayload, slackReplacement, slackReply, solicitLine, threadLine, verifySlackSignature, type SlackUserLookup } from "./slack.ts";
import type { SummaryRunSink } from "./summary-run-log.ts";
import { summarizeWindow, xaiDetailedSummarizer, type SummarizerFn } from "./summary.ts";
import { projectThreads } from "./thread.ts";
import { validateAlert } from "./validate.ts";

const MAX_BODY_BYTES = 1_000_000;
const PAGE = fileURLToPath(new URL("./page.html", import.meta.url));
const REPORT = fileURLToPath(new URL("./report.html", import.meta.url));

export function createIntakeServer(
  log: AlertLog,
  options: {
    summarize?: SummarizerFn | null;
    summaryRunLog?: SummaryRunSink | null;
    resolveUser?: SlackUserLookup | null;
  } = {},
): Server {
  const summarize = Object.prototype.hasOwnProperty.call(options, "summarize")
    ? options.summarize ?? null
    : xaiDetailedSummarizer(process.env, { source: "live" });
  const summaryRunLog = Object.prototype.hasOwnProperty.call(options, "summaryRunLog")
    ? options.summaryRunLog ?? null
    : null;
  const resolveUser = Object.prototype.hasOwnProperty.call(options, "resolveUser")
    ? options.resolveUser ?? null
    : slackUserLookup(process.env);
  return createServer(async (request, response) => {
    try {
      await handle(log, request, response, summarize, summaryRunLog, resolveUser);
    } catch {
      send(response, 500, "internal error");
    }
  });
}

function slackUserLookup(env: NodeJS.ProcessEnv): SlackUserLookup | null {
  const token = env.SLACK_BOT_TOKEN?.trim() ?? "";
  return token ? liveUserLookup(token) : null;
}

async function handle(
  log: AlertLog,
  request: IncomingMessage,
  response: ServerResponse,
  summarize: SummarizerFn | null,
  summaryRunLog: SummaryRunSink | null,
  resolveUser: SlackUserLookup | null,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/v1/shifts" && request.method === "GET") {
    const validation = validateShift({ start: url.searchParams.get("start"), end: url.searchParams.get("end") });
    if (!validation.ok) {
      send(response, 400, validation.error);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(buildShiftReport(log.list(), validation.start, validation.end)));
    return;
  }
  if (url.pathname === "/v1/shifts" && request.method === "POST") {
    await handleShift(log, request, response);
    return;
  }
  if (url.pathname === "/v1/summary" && request.method === "POST") {
    await handleSummary(log, request, response, summarize, summaryRunLog);
    return;
  }
  if (url.pathname === "/v1/responses" && request.method === "POST") {
    await handleResponse(log, request, response);
    return;
  }
  if (url.pathname === "/slack/interactions" && request.method === "POST") {
    await handleSlackInteraction(log, request, response);
    return;
  }
  if (url.pathname === "/slack/events" && request.method === "POST") {
    await handleSlackEvent(log, request, response, resolveUser);
    return;
  }
  if ((url.pathname === "/" || url.pathname === "/report") && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(readFileSync(url.pathname === "/report" ? REPORT : PAGE));
    return;
  }
  if (url.pathname === "/v1/threads" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ threads: projectThreads(log.list()) }));
    return;
  }
  if (url.pathname === "/v1/events" && request.method === "GET") {
    const alertKey = url.searchParams.get("alert_key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ events: listEvents(log, alertKey) }));
    return;
  }
  if (url.pathname !== "/v1/alerts") {
    send(response, 404, "not found");
    return;
  }
  if (request.method !== "POST") {
    send(response, 405, "method not allowed");
    return;
  }
  if (!isJson(request.headers["content-type"])) {
    send(response, 400, "Content-Type must be application/json");
    return;
  }

  const raw = await readBody(request);
  if (raw === undefined) {
    send(response, 400, "body is too large");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(response, 400, "body is not JSON");
    return;
  }

  const validation = validateAlert(parsed);
  if (!validation.ok) {
    send(response, 400, validation.error);
    return;
  }

  const eventId = (parsed as { event_id: string }).event_id;
  const header = request.headers["x-p8-event-id"];
  if (header !== eventId) {
    send(response, 400, "X-P8-Event-Id must match event_id");
    return;
  }

  const result = log.save(eventId, raw, new Date().toISOString());
  response.writeHead(result === "saved" ? 202 : 200);
  response.end();
  const slack = slackConfig(process.env);
  if (result === "saved" && slack) {
    void deliverSlack(log, parsed as Record<string, unknown>, liveSlack(slack.token), slack.channel).catch((error) => {
      console.error(error);
    });
  }
}

async function handleShift(log: AlertLog, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsed = await readJson(request, response);
  if (parsed === undefined) return;
  const validation = validateShift(parsed);
  if (!validation.ok) {
    send(response, 400, validation.error);
    return;
  }
  const closed = closeShift(log, validation.start, validation.end);
  response.writeHead(closed.created ? 202 : 200, { "content-type": "application/json" });
  response.end(JSON.stringify(closed.report));
}

async function handleSummary(
  log: AlertLog,
  request: IncomingMessage,
  response: ServerResponse,
  summarize: SummarizerFn | null,
  summaryRunLog: SummaryRunSink | null,
): Promise<void> {
  const parsed = await readJson(request, response);
  if (parsed === undefined) return;
  const validation = validateShift(parsed);
  if (!validation.ok) {
    send(response, 400, validation.error);
    return;
  }
  try {
    const paragraph = await summarizeWindow(log.list(), validation.start, validation.end, summarize, {
      runLog: summaryRunLog,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ paragraph }));
  } catch {
    send(response, 502, "summary failed");
  }
}

async function handleResponse(log: AlertLog, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isJson(request.headers["content-type"])) {
    send(response, 400, "Content-Type must be application/json");
    return;
  }
  const raw = await readBody(request);
  if (raw === undefined) {
    send(response, 400, "body is too large");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(response, 400, "body is not JSON");
    return;
  }
  const validation = validateResponse(parsed);
  if (!validation.ok) {
    send(response, 400, validation.error);
    return;
  }

  const result = applyHumanResponse(log, validation.value);
  if (result.error) {
    send(response, result.status, result.error);
    return;
  }
  response.writeHead(result.status);
  response.end();
}

async function handleSlackEvent(
  log: AlertLog,
  request: IncomingMessage,
  response: ServerResponse,
  resolveUser: SlackUserLookup | null,
): Promise<void> {
  const raw = await readBody(request);
  if (raw === undefined) {
    send(response, 400, "body is too large");
    return;
  }
  if (!signedSlack(request, raw)) {
    send(response, 401, "invalid signature");
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    send(response, 400, "body is not JSON");
    return;
  }
  const challenge = slackChallenge(payload);
  if (challenge) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ challenge }));
    return;
  }
  const reply = slackReply(payload);
  if (reply) {
    const named = await resolveReplyActor(reply, resolveUser);
    recordReply(log, named);
  }
  response.writeHead(200);
  response.end();
}

function signedSlack(request: IncomingMessage, raw: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET?.trim() ?? "";
  if (!secret) return true;
  return verifySlackSignature(raw, headerValue(request, "x-slack-request-timestamp"), headerValue(request, "x-slack-signature"), secret);
}

async function handleSlackInteraction(log: AlertLog, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readBody(request);
  if (raw === undefined) {
    send(response, 400, "body is too large");
    return;
  }
  if (new URLSearchParams(raw).get("ssl_check") === "1") {
    response.writeHead(200);
    response.end();
    return;
  }
  if (!signedSlack(request, raw)) {
    send(response, 401, "invalid signature");
    return;
  }
  const payload = slackPayload(raw);
  const action = payload ? slackButton(payload) : null;
  if (!action) {
    send(response, 400, "unrecognized action");
    return;
  }
  const actor = slackActor(payload);
  const target = clickEpisode(log, action);
  const result = applyHumanResponse(log, {
    alertKey: target.alertKey,
    action: action.action,
    note: null,
    actor,
    firingEventId: target.firingEventId,
  });
  const name = actor ?? "Someone";
  const solicit = solicitLine(action.action);
  const thread = threadLine(action.action, name);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(slackReplacement(target.alertKey, target.firingEventId, solicit, result.error)));
  const slack = slackConfig(process.env);
  if (!result.error && slack) {
    void showClick(log, liveSlack(slack.token), slack.channel, target.alertKey, target.firingEventId, solicit, thread, result.status === 202).catch((error) => {
      console.error(error);
    });
  }
}

function listEvents(log: AlertLog, alertKey: string | null): Array<{ eventId: string; receivedAt: string; body: unknown }> {
  const events = [];
  for (const event of log.list()) {
    let body: unknown = event.body;
    try {
      body = JSON.parse(event.body);
    } catch {
      body = event.body;
    }
    if (alertKey && !hasAlertKey(body, alertKey)) continue;
    events.push({ eventId: event.eventId, receivedAt: event.receivedAt, body });
  }
  return events;
}

function hasAlertKey(body: unknown, alertKey: string): boolean {
  return typeof body === "object" && body !== null && "alert_key" in body && body.alert_key === alertKey;
}

function isJson(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function readJson(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  if (!isJson(request.headers["content-type"])) {
    send(response, 400, "Content-Type must be application/json");
    return undefined;
  }
  const raw = await readBody(request);
  if (raw === undefined) {
    send(response, 400, "body is too large");
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    send(response, 400, "body is not JSON");
    return undefined;
  }
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function send(response: ServerResponse, status: number, error: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error }));
}
