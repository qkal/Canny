import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, trust } from "../src/config.js";

let cwd: string;

beforeEach(() => {
  process.env.CANNY_HOME = mkdtempSync(join(tmpdir(), "canny-config-home-"));
  cwd = mkdtempSync(join(tmpdir(), "canny-config-repo-"));
});

const write = (config: unknown): string => {
  const file = join(cwd, ".canny.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
};

describe("loadConfig", () => {
  it("drops the fields that turn checks off until the file is trusted", () => {
    write({ verify: ["^"], ignore: ["."], allow: ["secrets"], rules: ["no"], strict: true });
    expect(loadConfig(cwd)).toEqual({ rules: ["no"], strict: true });
    expect(loadConfig(mkdtempSync(join(tmpdir(), "canny-config-none-")))).toEqual({});
  });

  it("obeys a trusted file, and stops again the moment its contents change", () => {
    const file = write({ allow: ["secrets"] });
    trust(file);
    expect(loadConfig(cwd)).toEqual({ allow: ["secrets"] });
    write({ allow: ["secrets", "repeat-failure"] });
    expect(loadConfig(cwd)).toEqual({});
  });
});
