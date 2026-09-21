import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha } from "./checks.js";
import { home } from "./config.js";
const JEV_MODEL = process.env.CANNY_JEV_MODEL ?? "jev-latest";
const JEV_URL = process.env.CANNY_JEV_URL ?? "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = Number(process.env.CANNY_JEV_TIMEOUT_MS ?? 3000);
/** Jev drifts about 0.05 between runs, so only answers outside this band are acted on. */
export const YES = 0.9;
export const NO = 0.1;
export const noul = (instructions, criteria) => ({
    type: "noul",
    instructions,
    ...(criteria && { criteria }),
});
const hashOf = (body) => sha(JSON.stringify(body));
const cacheFile = (hash) => join(home(), "jev", `${hash}.json`);
/**
 * Written beside the file and renamed over it, the way `install.ts` writes settings: parallel hooks
 * miss the same key and answer it at once, and a half-written file would be read back as a miss.
 * A cache that cannot be written is not an error — the answer is already in hand, so it is kept.
 */
function writeCache(file, text) {
    // Unique per write rather than per process: two hosts sharing a home directory can hold the same
    // pid at once, and one writer's cleanup must never remove another's temporary file.
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        // Exclusive: a path already there, such as another hook's temp file, is never written through.
        writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
        renameSync(tmp, file);
    }
    catch {
        try {
            rmSync(tmp, { force: true });
        }
        catch {
            // Nothing to clean up: the cache directory could not be made in the first place.
        }
    }
}
/** A judge backed by TypeSafe's Jev, with a content-hash cache in front of it. */
export function makeJudge(opts) {
    const doFetch = opts.fetchFn ?? fetch;
    return async (state, questions) => {
        const body = { state, model: JEV_MODEL, questions };
        const hash = hashOf(body);
        const ids = Object.keys(questions);
        const file = cacheFile(hash);
        if (existsSync(file)) {
            try {
                const { answers } = JSON.parse(readFileSync(file, "utf8"));
                opts.log({ hash, ids, cached: true, ms: 0, answers });
                return answers;
            }
            catch {
                // A damaged cache file is treated as a miss.
            }
        }
        const key = process.env.TYPESAFE_API_KEY;
        if (!key)
            return null;
        const started = Date.now();
        try {
            const res = await doFetch(JEV_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const json = (await res.json());
            const answers = {};
            for (const id of ids) {
                const n = json.answers?.[id]?.noul;
                if (typeof n === "number")
                    answers[id] = n;
            }
            writeCache(file, JSON.stringify({ body, answers, ts: Date.now() }));
            opts.log({ hash, ids, cached: false, ms: Date.now() - started, answers });
            return answers;
        }
        catch (e) {
            opts.log({
                hash,
                ids,
                cached: false,
                ms: Date.now() - started,
                answers: null,
                error: String(e),
            });
            return null;
        }
    };
}
