import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sha } from "./checks.js";
import { isObj } from "./events.js";
/** Where sessions, the Jev cache, and the error log live. */
export const home = () => process.env.CANNY_HOME ?? join(homedir(), ".canny");
/** The hook fails open, so its crashes are only recorded here. */
export const errorLog = () => join(home(), "errors.log");
/** True when the user turned a check off through `allow`. */
export const off = (config, check) => (config.allow ?? []).includes(check);
/** Fields that can only loosen the guard, so they wait for `canny trust`. The rest are safe to obey. */
export const WEAKENING = ["verify", "ignore", "rules", "allow"];
/** The weakening fields a config actually sets: what `trust` would enable, and what `status` reports as ignored. */
export const weakened = (config) => WEAKENING.filter((f) => config[f] !== undefined);
/** The nearest `.canny.json` at or above `cwd`, stopping at the home directory. */
export function findConfig(cwd) {
    let dir = cwd;
    const stop = homedir();
    for (;;) {
        const file = join(dir, ".canny.json");
        if (existsSync(file)) {
            const text = readText(file);
            return {
                file,
                config: parse(text),
                trusted: text !== "" && store()[file] === sha(text),
            };
        }
        const parent = dirname(dir);
        if (dir === stop || parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * A `.canny.json` lives in the workspace the agent is editing, so anything in it that turns a check
 * off or replaces a check's input is ignored until the user runs `canny trust`. `strict` only ever
 * asks for more.
 */
export function loadConfig(cwd) {
    const found = findConfig(cwd);
    if (!found)
        return {};
    if (found.trusted)
        return found.config;
    const config = { ...found.config };
    for (const field of WEAKENING)
        delete config[field];
    return config;
}
/** Record a config file's current contents as trusted. Only the user runs this. */
export function trust(file) {
    const next = { ...store(), [file]: sha(readText(file)) };
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    writeFileSync(trustFile(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}
const trustFile = () => join(home(), "trusted.json");
const store = () => parse(readText(trustFile()));
/** Anything but a JSON object — `null`, an array, a number, junk — is treated as no config at all. */
function parse(text) {
    try {
        const value = JSON.parse(text);
        return isObj(value) ? value : {};
    }
    catch {
        return {};
    }
}
const readText = (file) => {
    try {
        return readFileSync(file, "utf8");
    }
    catch {
        return "";
    }
};
