import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            writeFileSync(file, JSON.stringify({ body, answers, ts: Date.now() }), { mode: 0o600 });
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
