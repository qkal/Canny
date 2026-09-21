import { config } from "./config.js";

/** Charge an amount in cents. `fetch` can be swapped out in tests. */
export async function createCharge(amount, { fetch = globalThis.fetch } = {}) {
  throw new Error(`not implemented: would POST ${amount} to ${config.apiBase}`);
}
