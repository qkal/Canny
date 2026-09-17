import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractRules, loadRules } from "../src/rules.js";

const md = `# Rules

Some prose that should never be picked up because it is a paragraph.

- Never commit secrets to the repo.
- The office plant is named Fern.
- Use \`pnpm\`, not npm or yarn, for every
  package operation.
1. Always run the tests before saying done.

\`\`\`
- not a rule, inside a fence, must stay out
\`\`\`
`;

describe("extractRules", () => {
  it("keeps instruction-like bullets, joins continuations, skips prose and fences", () => {
    expect(extractRules(md)).toEqual([
      "Never commit secrets to the repo.",
      "Use pnpm, not npm or yarn, for every package operation.",
      "Always run the tests before saying done.",
    ]);
  });
});

describe("loadRules", () => {
  it("prefers config rules, else reads CLAUDE.md and AGENTS.md with strong rules first", () => {
    const dir = mkdtempSync(join(tmpdir(), "canny-rules-"));
    writeFileSync(
      join(dir, "AGENTS.md"),
      "- Prefer small diffs over big ones.\n- Never force-push.\n",
    );
    expect(loadRules(dir, {})).toEqual({
      source: "AGENTS.md",
      rules: ["Never force-push.", "Prefer small diffs over big ones."],
    });
    expect(loadRules(dir, { rules: ["custom"] })).toEqual({
      source: ".canny.json",
      rules: ["custom"],
    });
    expect(loadRules(mkdtempSync(join(tmpdir(), "canny-empty-")), {})).toBeNull();
  });
});
