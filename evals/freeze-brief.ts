/**
 * Rebuilds a golden case brief from its fixture and writes brief.txt.
 * Usage: node --experimental-strip-types evals/freeze-brief.ts older-done-newer-firing
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { briefForOlderDoneNewerFiring } from "./fixtures/older-done-newer-firing.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "golden");
const id = process.argv[2] ?? "older-done-newer-firing";

const briefs: Record<string, () => Promise<string>> = {
  "older-done-newer-firing": briefForOlderDoneNewerFiring,
};

const build = briefs[id];
if (!build) {
  console.error(`unknown case: ${id}`);
  process.exit(1);
}

const brief = await build();
const dir = join(root, id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "brief.txt"), `${brief}\n`, "utf8");
console.log(`wrote ${join(dir, "brief.txt")} (${brief.length} chars)`);
