import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { plain } from "./checks.js";
const STRONG = /\b(never|always|must|do not|don't|no\s+\w)\b/i;
const SOFT = /\b(should|prefer|avoid|only|use|keep|run)\b/i;
const MAX_RULES = 24;
/** Rules from `.canny.json`, or else instruction-like bullets from the project's agent rule files. */
export function loadRules(cwd, config) {
    if (config.rules?.length)
        return { source: ".canny.json", rules: config.rules.slice(0, MAX_RULES) };
    const found = [];
    const rules = [];
    for (const name of ["CLAUDE.md", "AGENTS.md", join(".claude", "CLAUDE.md")]) {
        const file = join(cwd, name);
        if (!existsSync(file))
            continue;
        found.push(name);
        rules.push(...extractRules(readFileSync(file, "utf8")));
    }
    const strong = rules.filter((r) => STRONG.test(r));
    const soft = rules.filter((r) => !STRONG.test(r));
    const picked = [...new Set([...strong, ...soft])].slice(0, MAX_RULES);
    return picked.length ? { source: found.join(", "), rules: picked } : null;
}
/** Bullet and numbered lines that read like an instruction. Prose and code fences are left out. */
export function extractRules(markdown) {
    const out = [];
    let inFence = false;
    let pending = "";
    const flush = () => {
        const t = pending.trim();
        if (t.length >= 12 && (STRONG.test(t) || SOFT.test(t)))
            out.push(t);
        pending = "";
    };
    for (const raw of markdown.split("\n")) {
        if (/^\s*```/.test(raw)) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
        if (m) {
            flush();
            pending = clean(m[1]);
            continue;
        }
        if (pending && /^\s{2,}\S/.test(raw)) {
            pending += " " + clean(raw);
            continue;
        }
        flush();
    }
    flush();
    return out;
}
const clean = (s) => plain(s)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
