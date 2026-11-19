/** Future or suspended, unexpired grants still prevent buying the same course twice. */
export const unexpiredGrant = (now: Date) => ({ revoked_at: null, OR: [{ ends_at: null }, { ends_at: { gt: now } }] });
