import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { briefForOlderDoneNewerFiring } from "../evals/fixtures/older-done-newer-firing.ts";
import { SUMMARY_PROMPT_VERSION } from "../src/summary.ts";

describe("golden brief freeze", () => {
  it("older-done-newer-firing brief matches the journey fixture", async () => {
    const frozen = readFileSync(join("evals/golden/older-done-newer-firing/brief.txt"), "utf8").replace(/\n$/, "");
    const live = await briefForOlderDoneNewerFiring();
    expect(live).toBe(frozen);
    expect(frozen).toContain("filter was blocked");
    expect(frozen).toContain("Reply from bao");
    expect(frozen).toContain("Attention open: 1");
    expect(frozen).toContain("Condition firing: 1");

    const meta = JSON.parse(readFileSync(join("evals/golden/older-done-newer-firing/meta.json"), "utf8")) as {
      prompt_version: string;
      must_mention: string[];
    };
    expect(meta.prompt_version).toBe(SUMMARY_PROMPT_VERSION);
    for (const needle of meta.must_mention) expect(frozen.toLowerCase()).toContain(needle.toLowerCase());
  });
});
