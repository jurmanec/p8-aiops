import { register, type NodeTracerProvider } from "@arizeai/phoenix-otel";

/** Phoenix project for the summary-trace experiment ([004](../docs/planning/004-phoenix-trace-comparison.md)). */
export const PHOENIX_PROJECT = "p8-summary";

let provider: NodeTracerProvider | null = null;

/** Register the Phoenix OTLP exporter once. Spans still need step-4 instrumentation around the model call. */
export function registerPhoenix(): NodeTracerProvider {
  if (provider) return provider;
  provider = register({ projectName: PHOENIX_PROJECT });
  return provider;
}

export function phoenixProvider(): NodeTracerProvider | null {
  return provider;
}
