/**
 * Upsert the first golden case into a Phoenix dataset and run a CODE experiment
 * that mirrors local must_mention / must_not checks (evals/run.ts).
 *
 * Requires Phoenix at http://localhost:6006 (or PHOENIX_COLLECTOR_ENDPOINT / PHOENIX_HOST).
 * Live model call needs XAI_API_KEY (same as EVAL_LIVE golden).
 *
 * Usage:
 *   npm run eval:phoenix
 *   npm run eval:phoenix -- --dataset-only
 *   npm run eval:phoenix -- older-done-newer-firing
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@arizeai/phoenix-client";
import { createDataset } from "@arizeai/phoenix-client/datasets";
import { asExperimentEvaluator, runExperiment } from "@arizeai/phoenix-client/experiments";
import { registerPhoenix } from "../src/phoenix.ts";
import { xaiDetailedSummarizer } from "../src/summary.ts";

type CaseMeta = {
  id: string;
  prompt_version: string;
  must_mention: string[];
  must_not: string[];
  notes?: string;
};

type Criteria = {
  must_mention: string[];
  must_not: string[];
};

const DATASET_NAME = "p8-golden-summary";
const evalRoot = dirname(fileURLToPath(import.meta.url));
const goldenRoot = join(evalRoot, "golden");
const argv = process.argv.slice(2);
const datasetOnly = argv.includes("--dataset-only");
const caseId = argv.find((a) => !a.startsWith("-")) ?? "older-done-newer-firing";

loadEnvFile(join(evalRoot, "..", ".env"));

const { meta, brief } = loadCase(goldenRoot, caseId);
const client = createClient();
const provider = registerPhoenix();

try {
  const { datasetId } = await createDataset({
    client,
    name: DATASET_NAME,
    description:
      "P8 window-summary golden briefs. Criteria match evals/golden meta.json (must_mention / must_not). Experiment task calls xaiDetailedSummarizer.",
    examples: [
      {
        id: meta.id,
        input: { brief },
        output: {
          must_mention: meta.must_mention,
          must_not: meta.must_not,
        },
        metadata: {
          case_id: meta.id,
          prompt_version: meta.prompt_version,
          notes: meta.notes ?? "",
          local_harness: "evals/run.ts",
        },
      },
    ],
  });

  console.log(`dataset: ${DATASET_NAME} (${datasetId})`);
  console.log(`example: ${meta.id}`);
  console.log(`open http://127.0.0.1:6006/datasets/${datasetId}/examples`);

  if (datasetOnly) {
    console.log("dataset-only: skipping experiment");
    process.exit(0);
  }

  const summarizer = xaiDetailedSummarizer(process.env, { source: "eval" });
  if (!summarizer) {
    console.error("XAI_API_KEY unset; use --dataset-only or set the key");
    process.exit(1);
  }

  const experiment = await runExperiment({
    client,
    dataset: { datasetId },
    experimentName: `golden-${meta.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    experimentDescription: "CODE evaluators: must_mention, must_not, ok (same rules as evals/run.ts)",
    experimentMetadata: {
      case_id: meta.id,
      prompt_version: meta.prompt_version,
      mirror: "evals/run.ts",
    },
    task: async (example) => {
      const userBrief = String((example.input as { brief?: unknown }).brief ?? "");
      const result = await summarizer(userBrief);
      return result.content.trim();
    },
    evaluators: [
      asExperimentEvaluator({
        name: "must_mention",
        kind: "CODE",
        evaluate: async ({ output, expected }) => {
          const paragraph = asText(output);
          const { must_mention } = criteriaOf(expected);
          const missing = must_mention.filter((s) => !paragraph.toLowerCase().includes(s.toLowerCase()));
          const ok = missing.length === 0;
          return {
            label: ok ? "pass" : "fail",
            score: ok ? 1 : 0,
            explanation: ok ? "all must_mention present" : `missing: ${missing.join(", ")}`,
            metadata: { missing },
          };
        },
      }),
      asExperimentEvaluator({
        name: "must_not",
        kind: "CODE",
        evaluate: async ({ output, expected }) => {
          const paragraph = asText(output);
          const { must_not } = criteriaOf(expected);
          const forbidden = must_not.filter((s) => paragraph.toLowerCase().includes(s.toLowerCase()));
          const ok = forbidden.length === 0;
          return {
            label: ok ? "pass" : "fail",
            score: ok ? 1 : 0,
            explanation: ok ? "no must_not present" : `forbidden: ${forbidden.join(", ")}`,
            metadata: { forbidden },
          };
        },
      }),
      asExperimentEvaluator({
        name: "ok",
        kind: "CODE",
        evaluate: async ({ output, expected }) => {
          const paragraph = asText(output);
          const { must_mention, must_not } = criteriaOf(expected);
          const missing = must_mention.filter((s) => !paragraph.toLowerCase().includes(s.toLowerCase()));
          const forbidden = must_not.filter((s) => paragraph.toLowerCase().includes(s.toLowerCase()));
          const ok = missing.length === 0 && forbidden.length === 0;
          return {
            label: ok ? "ok" : "FAIL",
            score: ok ? 1 : 0,
            explanation: ok ? "same as local harness ok" : `missing=[${missing.join(", ")}] forbidden=[${forbidden.join(", ")}]`,
            metadata: { missing, forbidden },
          };
        },
      }),
    ],
  });

  console.log(`experiment: ${experiment.id}`);
  console.log(`open http://127.0.0.1:6006/datasets/${datasetId}/experiments`);
  for (const run of experiment.evaluationRuns ?? []) {
    const name = "name" in run ? String((run as { name?: string }).name ?? "") : "";
    const score = "result" in run ? (run as { result?: { score?: number; label?: string } }).result : undefined;
    if (score) console.log(`  eval ${name || "?"}: ${score.label ?? ""} score=${score.score}`);
  }
} finally {
  await provider.shutdown();
}

function criteriaOf(expected: unknown): Criteria {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    return { must_mention: [], must_not: [] };
  }
  const record = expected as Record<string, unknown>;
  return {
    must_mention: stringList(record.must_mention),
    must_not: stringList(record.must_not),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

function loadCase(root: string, id: string): { meta: CaseMeta; brief: string } {
  const dir = join(root, id);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as CaseMeta;
  const brief = readFileSync(join(dir, "brief.txt"), "utf8").replace(/\n$/, "");
  if (meta.id !== id) throw new Error(`meta.id ${meta.id} != ${id}`);
  return { meta, brief };
}

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
