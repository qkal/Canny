/** One line per action, for the audit trail. */
export const auditLine = (session, action) => `${session.userId} ${action}`;
