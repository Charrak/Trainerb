/** Only enable behind an independently access-controlled development preview. */
export function testInboxEnabled(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.TRAINERB_TEST_INBOX === 'true';
}

/** Convert only known account-action links to the current preview origin. */
export function localTestAction(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s]+/g)) {
    try {
      const url = new URL(match[0]);
      if (!['/konto/aktivieren', '/konto/passwort-zuruecksetzen', '/konto/email-bestaetigen'].includes(url.pathname) || url.search) continue;
      const token = new URLSearchParams(url.hash.slice(1)).get('token');
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) return `${url.pathname}#token=${token}`;
    } catch { /* Ignore malformed links. */ }
  }
  return null;
}
