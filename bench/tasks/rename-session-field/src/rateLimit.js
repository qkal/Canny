const WINDOW = 60;

/** The bucket a request counts against. */
export function bucketFor(session, now) {
  return `rl:${session.userId}:${Math.floor(now / WINDOW)}`;
}
