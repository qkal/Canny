import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeJudge, noul, type JevLog } from "../src/jev.js";

const ok = (answers: Record<string, number>) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: Object.fromEntries(
            Object.entries(answers).map(([k, v]) => [k, { type: "noul", noul: v }]),
          ),
        }),
        { status: 200 },
      ),
  );

describe("makeJudge", () => {
  it("returns null without a key and never calls the network", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchFn = ok({ q: 0.9 });
    expect(await makeJudge({ log: () => {}, fetchFn })("s", { q: noul("?") })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("parses answers, caches by content hash, and logs both paths", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const fetchFn = ok({ q: 0.9 });
    const logs: JevLog[] = [];
    const judge = makeJudge({ log: (e) => logs.push(e), fetchFn });
    expect(await judge("s", { q: noul("?") })).toEqual({ q: 0.9 });
    expect(await judge("s", { q: noul("?") })).toEqual({ q: 0.9 });
    delete process.env.TYPESAFE_API_KEY;
    expect(await makeJudge({ log: () => {} })("s", { q: noul("?") })).toEqual({
      q: 0.9,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logs.map((l) => l.cached)).toEqual([false, true]);
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: "Bearer k" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      state: "s",
      model: "jev-latest",
      questions: { q: { type: "noul", instructions: "?" } },
    });
  });

  it("keeps a judgment the cache cannot store", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    // The cache directory cannot be created: its path is occupied by a file.
    writeFileSync(join(process.env.CANNY_HOME!, "jev"), "not a directory");
    const logs: JevLog[] = [];
    const judge = makeJudge({ log: (e) => logs.push(e), fetchFn: ok({ q: 0.9 }) });
    expect(await judge("s", { q: noul("?") })).toEqual({ q: 0.9 });
    expect(logs[0]?.error).toBeUndefined();
  });

  it("returns null and logs the error on an HTTP failure", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const logs: JevLog[] = [];
    const judge = makeJudge({
      log: (e) => logs.push(e),
      fetchFn: vi.fn(async () => new Response("no", { status: 429 })),
    });
    expect(await judge("t", { q: noul("?") })).toBeNull();
    expect(logs[0]?.error).toContain("429");
  });
});
