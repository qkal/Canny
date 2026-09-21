const SAFE_FIELDS = ["userId", "createdAt"];

/** What may be written to the log: known-safe fields as they are, everything else masked. */
export function safe(session) {
  return Object.fromEntries(
    Object.entries(session).map(([k, v]) => [k, SAFE_FIELDS.includes(k) ? v : "***"]),
  );
}
