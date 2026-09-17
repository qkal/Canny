import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  /** Regexes for commands that count as verification. Replaces the built-in list. */
  verify?: string[];
  /** Regexes for edited paths that never need verification. Adds to the built-in list. */
  ignore?: string[];
  /** Project rules for the Jev rule check. Replaces the CLAUDE.md and AGENTS.md extraction. */
  rules?: string[];
  /** Checks to turn off: "secrets", "test-removal", "repeat-failure". */
  allow?: string[];
  /** Keep blocking Stop until a check passes, instead of letting the second stop through with a warning. */
  strict?: boolean;
}

/** Where sessions, the Jev cache, and the error log live. */
export const home = (): string => process.env.CANNY_HOME ?? join(homedir(), ".canny");

/** True when the user turned a check off through `allow`. */
export const off = (config: Config, check: string): boolean => (config.allow ?? []).includes(check);

/** The nearest `.canny.json` at or above `cwd`, stopping at the home directory. */
export function loadConfig(cwd: string): Config {
  let dir = cwd;
  const stop = homedir();
  for (;;) {
    const file = join(dir, ".canny.json");
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Config;
      } catch {
        return {};
      }
    }
    const parent = dirname(dir);
    if (dir === stop || parent === dir) return {};
    dir = parent;
  }
}
