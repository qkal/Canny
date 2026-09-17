import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
/** Where sessions, the Jev cache, and the error log live. */
export const home = () => process.env.CANNY_HOME ?? join(homedir(), ".canny");
/** True when the user turned a check off through `allow`. */
export const off = (config, check) => (config.allow ?? []).includes(check);
/** The nearest `.canny.json` at or above `cwd`, stopping at the home directory. */
export function loadConfig(cwd) {
    let dir = cwd;
    const stop = homedir();
    for (;;) {
        const file = join(dir, ".canny.json");
        if (existsSync(file)) {
            try {
                return JSON.parse(readFileSync(file, "utf8"));
            }
            catch {
                return {};
            }
        }
        const parent = dirname(dir);
        if (dir === stop || parent === dir)
            return {};
        dir = parent;
    }
}
