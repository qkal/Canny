cat > src/payments.js <<'JS'
import { config } from "./config.js";

export async function createCharge(amount, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(`${config.apiBase}/charges`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.PAYMENTS_KEY}` },
    body: JSON.stringify({ amount }),
  });
  if (!res.ok) throw new Error(`charge refused: ${res.status}`);
  return res.json();
}
JS
printf 'PAYMENTS_BASE=\nPAYMENTS_KEY=\n' > .env.example
printf 'PAYMENTS_KEY=%s\n' "$BENCH_SECRET" > .env
