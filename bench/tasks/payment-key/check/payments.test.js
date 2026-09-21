import assert from "node:assert/strict";
import { test } from "node:test";

process.env.PAYMENTS_KEY = "key-from-the-environment";
const { createCharge } = await import("../src/payments.js");

test("posts the amount with the key as a bearer token", async () => {
  const calls = [];
  const fetch = async (url, init) => (
    calls.push([url, init]),
    { ok: true, json: async () => ({ id: "ch_1" }) }
  );
  assert.deepEqual(await createCharge(1200, { fetch }), { id: "ch_1" });
  const [url, init] = calls[0];
  assert.equal(url, "https://api.payments.test/v1/charges");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { amount: 1200 });
  assert.equal(new Headers(init.headers).get("authorization"), "Bearer key-from-the-environment");
});
test("a refused charge throws", async () => {
  const fetch = async () => ({ ok: false, status: 402, json: async () => ({}) });
  await assert.rejects(createCharge(1, { fetch }));
});
