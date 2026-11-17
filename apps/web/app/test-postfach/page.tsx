import { notFound } from 'next/navigation';
import { SimpleLayout, Arrow, Notice } from '../../components/site';
import { localTestAction, testInboxEnabled } from '../../lib/test-inbox';

export const dynamic = 'force-dynamic';

interface Summary { ID?: string; Subject?: string; To?: { Address?: string }[] }
interface TestMessage { id: string; subject: string; to: string; text: string; link: string | null }

async function readMailbox(): Promise<TestMessage[]> {
  // The mail catcher is contacted only by the web server, on loopback. No
  // browser request can choose a host or reach an arbitrary URL.
  const root = 'http://127.0.0.1:8025';
  const listResponse = await fetch(`${root}/api/v1/messages?limit=25`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
  if (!listResponse.ok) throw new Error('Mail catcher unavailable');
  const payload: { messages?: Summary[] } = await listResponse.json();
  const items = Array.isArray(payload.messages) ? payload.messages.slice(0, 25) : [];
  const messages = await Promise.all(items.map(async item => {
    if (!item.ID || !/^[A-Za-z0-9_-]{1,128}$/.test(item.ID)) return null;
    const response = await fetch(`${root}/api/v1/message/${encodeURIComponent(item.ID)}`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Mail catcher unavailable');
    const body: { Text?: unknown } = await response.json();
    const text = typeof body.Text === 'string' ? body.Text.slice(0, 16_000) : '';
    return { id: item.ID, subject: typeof item.Subject === 'string' ? item.Subject : '(Ohne Betreff)',
      to: Array.isArray(item.To) ? item.To.map(x => x.Address || '').filter(Boolean).join(', ') : '', text, link: localTestAction(text) };
  }));
  return messages.filter((message): message is TestMessage => message !== null);
}

export default async function TestInboxPage() {
  // Explicit opt-in and NODE_ENV=development are both required. There is no
  // public mailbox route in production, even if the flag is set by mistake.
  if (!testInboxEnabled()) notFound();
  let messages: TestMessage[] = []; let unavailable = false;
  try { messages = await readMailbox(); } catch { unavailable = true; }
  return <SimpleLayout eyebrow="NUR ZUM TESTEN"><div className="standalone-card test-inbox-card">
    <span className="section-kicker">ENTWICKLUNGSVORSCHAU</span><h1>Test-Postfach.</h1>
    <p>Hier erscheinen abgefangene Test-Mails. Nach der Registrierung gegebenenfalls ein paar Sekunden warten und aktualisieren.</p>
    <Notice kind="info" message="Dieses Postfach ist nicht privat: Alle mit Zugriff auf die Vorschau können die Nachrichten lesen. Bitte nur erfundene Daten und Testpasswörter verwenden."/>
    <a className="button button-secondary" href="/test-postfach">Aktualisieren <Arrow/></a>
    {unavailable ? <Notice message="Das Test-Postfach ist gerade nicht erreichbar. Bitte später erneut versuchen."/> : messages.length === 0
      ? <p className="test-inbox-empty">Noch keine Testnachrichten vorhanden.</p>
      : <div className="test-inbox-list">{messages.map(message => <article className="test-inbox-message" key={message.id}>
        <h2>{message.subject}</h2><p>An: {message.to || 'Unbekannt'}</p>
        <pre>{message.text.replace(/https?:\/\/[^\s]+/g, '[Link siehe unten]')}</pre>
        {message.link && <a className="button button-primary" href={message.link}>Bestätigungslink öffnen <Arrow/></a>}
      </article>)}</div>}
  </div></SimpleLayout>;
}
