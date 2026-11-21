const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SEVERITIES = new Set(["critical", "warning", "info"]);

export type Validation = { ok: true } | { ok: false; error: string };

export function validateAlert(body: unknown): Validation {
  if (!isObject(body)) return fail("body must be a JSON object");
  if (body.contract !== "p8.alert") return fail("contract must be p8.alert");
  const common = checkCommon(body);
  if (!common.ok) return common;
  if (body.version === "0.2") return checkV02(body);
  if (body.version === "0.3") return checkV03(body);
  return fail("version must be 0.2 or 0.3");
}

function checkCommon(body: Record<string, unknown>): Validation {
  if (!nonEmpty(body.event_id)) return fail("event_id must be a non-empty string");
  if (!nonEmpty(body.alert_key)) return fail("alert_key must be a non-empty string");
  if (body.transition !== "FIRING" && body.transition !== "RESOLVED") {
    return fail("transition must be FIRING or RESOLVED");
  }
  if (!isTimestamp(body.emitted_at)) return fail("emitted_at must be a UTC timestamp");
  if (!isTimestamp(body.fired_at)) return fail("fired_at must be a UTC timestamp");
  if (body.transition === "FIRING" && body.resolved_at !== null) {
    return fail("resolved_at must be null on FIRING");
  }
  if (body.transition === "RESOLVED" && !isTimestamp(body.resolved_at)) {
    return fail("resolved_at must be a UTC timestamp on RESOLVED");
  }
  const severity = checkSeverity(body);
  if (severity) return severity;
  const optional = checkOptionalStrings(body, ["source", "team", "manual_url", "summary"]);
  if (optional) return optional;
  if ("identity_tags" in body && !isStringMap(body.identity_tags)) {
    return fail("identity_tags must be an object of strings");
  }
  if ("details" in body && !isObject(body.details)) return fail("details must be an object");
  return { ok: true };
}

function checkV02(body: Record<string, unknown>): Validation {
  if (!nonEmpty(body.monitor_id)) return fail("monitor_id must be a non-empty string");
  if (!nonEmpty(body.job_id)) return fail("job_id must be a non-empty string");
  if (!isStringMap(body.time_series_tags)) {
    return fail("time_series_tags must be an object of strings");
  }
  const optional = checkOptionalStrings(body, ["monitor_name"]);
  if (optional) return optional;
  if ("condition_tag_keys" in body && !isStringArray(body.condition_tag_keys)) {
    return fail("condition_tag_keys must be an array of strings");
  }
  return { ok: true };
}

function checkV03(body: Record<string, unknown>): Validation {
  if (!isStringMap(body.labels)) return fail("labels must be an object of strings");
  return { ok: true };
}

function checkSeverity(body: Record<string, unknown>): Validation | undefined {
  if (!("severity" in body) || body.severity === null) return undefined;
  if (typeof body.severity === "string" && SEVERITIES.has(body.severity)) return undefined;
  return fail("severity must be critical, warning, info, or null");
}

function checkOptionalStrings(body: Record<string, unknown>, keys: string[]): Validation | undefined {
  for (const key of keys) {
    if (key in body && typeof body[key] !== "string") return fail(`${key} must be a string`);
  }
  return undefined;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringMap(value: unknown): boolean {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: string): Validation {
  return { ok: false, error };
}
