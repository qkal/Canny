export function createSession({ userId, token }) {
  if (!userId) throw new TypeError("a session needs a userId");
  return { userId, token, createdAt: 0 };
}
