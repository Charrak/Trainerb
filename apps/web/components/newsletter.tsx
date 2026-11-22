'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';
type Policy = { policy: string; wording: string };
export function Newsletter({ mode = 'subscribe' }: { mode?: 'subscribe' | 'confirm' | 'unsubscribe' }) {
  const [p, setP] = useState<Policy | null>(),
    [email, setEmail] = useState(''),
    [topic, setTopic] = useState('kurse'),
    [checked, check] = useState(false),
    [token, setToken] = useState(''),
    [leave, setLeave] = useState(''),
    [busy, B] = useState(false),
    [error, E] = useState(''),
    [done, D] = useState(false);
  useEffect(() => {
    let active = true;
    if (mode === 'subscribe') {
      api<Policy | null>('/newsletter/policy')
        .then((p) => {
          if (active) setP(p ?? null);
        })
        .catch((e) => {
          if (active) E(errorMessage(e));
        });
    } else {
      setToken(new URLSearchParams(location.hash.slice(1)).get('token') ?? '');
    }
    return () => {
      active = false;
    };
  }, [mode]);
  async function submit() {
    B(true);
    E('');
    try {
      const r = await api<{ unsubscribe_token?: string }>(
        '/newsletter/' + mode,
        'POST',
        mode === 'subscribe' ? { email, topic, accepted: checked, policy: p?.policy } : { token },
      );
      if (r.unsubscribe_token) setLeave(r.unsubscribe_token);
      D(true);
      if (mode !== 'subscribe') history.replaceState(null, '', location.pathname);
      setToken('');
    } catch (e) {
      E(errorMessage(e));
    } finally {
      B(false);
    }
  }
  return (
    <section className="simple-page content-width">
      <span className="eyebrow">AKADEMIE</span>
      <h1>
        {mode === 'subscribe' ? 'Newsletter' : mode === 'confirm' ? 'Anmeldung bestätigen' : 'Newsletter abbestellen'}
      </h1>
      <Notice message={error} />
      {done ? (
        <>
          <Notice
            kind="success"
            message={
              mode === 'subscribe'
                ? 'Wenn eine Bestätigung erforderlich ist, erhältst du eine E-Mail.'
                : mode === 'confirm'
                  ? 'Deine Newsletter-Anmeldung ist bestätigt.'
                  : 'Deine Abmeldung wurde verarbeitet.'
            }
          />
          {leave && <Link href={'/newsletter/abmelden#token=' + leave}>Newsletter wieder abbestellen</Link>}
        </>
      ) : mode === 'subscribe' ? (
        p ? (
          <form
            className="stack-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label>
              E-Mail-Adresse
              <input
                required
                type="email"
                autoComplete="email"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Thema
              <select value={topic} onChange={(e) => setTopic(e.target.value)}>
                <option value="kurse">Kurse</option>
                <option value="akademie">Akademie</option>
              </select>
            </label>
            <label>
              <input type="checkbox" checked={checked} onChange={(e) => check(e.target.checked)} required /> {p.wording}
            </label>
            <Link href="/datenschutz">Datenschutz lesen</Link>
            <button className="button button-primary" disabled={busy || !checked}>
              Bestätigungslink anfordern
            </button>
          </form>
        ) : (
          <p>{p === null ? 'Derzeit ist keine Anmeldung möglich.' : !error ? 'Anmeldung wird geladen …' : ''}</p>
        )
      ) : (
        <>
          <p>
            {mode === 'confirm'
              ? 'Erst mit deiner Bestätigung wird die Adresse angemeldet.'
              : 'Künftige Nachrichten dieser Anmeldung werden gestoppt. Dein Konto und deine Käufe bleiben unverändert.'}
          </p>
          <button className="button button-primary" disabled={!token || busy} onClick={submit}>
            {mode === 'confirm' ? 'Newsletter-Anmeldung bestätigen' : 'Jetzt abbestellen'}
          </button>
        </>
      )}
    </section>
  );
}
type Campaign = {
  id: string;
  subject: string;
  body: string;
  audience: string;
  status: string;
  scheduled_at: string | null;
  audience_size: number | null;
  total: number;
  accepted: number;
  suppressed: number;
  failed: number;
};
type Workspace = { enabled: boolean; data: Campaign[] };
type Audience = { key: string; size: number };
type Reach = { available: boolean; data: Audience[] };
const states: Record<string, string> = {
  draft: 'Entwurf',
  scheduled: 'Geplant',
  frozen: 'Empfänger festgelegt',
  paused: 'Angehalten',
  cancelled: 'Gestoppt',
};
const topics: Record<string, string> = {
  all: 'Alle bestätigten Themen', kurse: 'Thema Kurse', akademie: 'Thema Akademie',
  kurse_aktiv: 'Lernende mit aktivem Zugang (Thema Kurse)',
};
export function Campaigns() {
  const [ws, W] = useState<Workspace>(),
    [subject, S] = useState(''),
    [body, T] = useState(''),
    [audience, A] = useState('all'),
    [at, F] = useState(''),
    [selected, select] = useState(''),
    [reach, setReach] = useState<Reach>(),
    [mail, M] = useState(''),
    [reason, R] = useState('bounced'),
    [busy, B] = useState(false),
    [error, E] = useState(''),
    [notice, N] = useState('');
  const load = async () => {
    W(await api<Workspace>('/admin/newsletter/campaigns'));
    setReach(await api<Reach>('/admin/newsletter/audiences'));
  };
  useEffect(() => {
    load().catch((e) => E(errorMessage(e)));
  }, []);
  async function act(path: string, payload: unknown, msg: string) {
    B(true);
    E('');
    N('');
    try {
      const r = await api<{ id?: string }>(path, 'POST', payload);
      if (r.id) {
        select(r.id);
        S('');
        T('');
      }
      M('');
      N(msg);
      await load();
    } catch (e) {
      E(errorMessage(e));
    } finally {
      B(false);
    }
  }
  const c = ws?.data.find((r) => r.id === selected);
  return (
    <div className="account-page content-width">
      <header className="dashboard-title">
        <div>
          <span className="eyebrow">REDAKTION</span>
          <h1>Newsletter-Kampagnen</h1>
        </div>
        <Link href="/konto">Zum Konto</Link>
      </header>
      <Notice message={error} />
      <Notice kind="success" message={notice} />
      {ws && (
        <>
          <p>
            {ws.enabled ? 'Versand technisch aktiviert.' : 'Der Kampagnenversand ist in dieser Umgebung ausgeschaltet.'}{' '}
            Es werden keine Öffnungen oder Klicks erfasst.
          </p>
          <fieldset disabled={busy} className="dashboard-card stack-form">
            <legend>Neuer Entwurf</legend>
            <label>
              Betreff
              <input value={subject} maxLength={160} onChange={(e) => S(e.target.value)} />
            </label>
            <label>
              Nachricht (Klartext)
              <textarea value={body} maxLength={12000} onChange={(e) => T(e.target.value)} />
            </label>
            <label>
              Empfängergruppe
              <select value={audience} onChange={(e) => A(e.target.value)}>
                {Object.entries(topics).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                    {reach?.available && reach.data.some((a) => a.key === k)
                      ? ` — ${reach.data.find((a) => a.key === k)!.size} Adressen`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {reach?.available
                ? 'Die Zahlen zählen bestätigte Einwilligungen der aktuellen Fassung; sie werden beim Einfrieren und vor jeder Übergabe erneut geprüft.'
                : 'Für eine genaue Reichweite fehlt der freigegebene Einwilligungstext oder eine aktive Datenschutzfassung.'}
            </p>
            <button
              disabled={!subject.trim() || !body.trim()}
              onClick={() => act('/admin/newsletter/campaigns', { subject, body, audience }, 'Entwurf gespeichert.')}
            >
              Entwurf speichern
            </button>
          </fieldset>
          <fieldset disabled={busy} className="dashboard-card stack-form">
            <legend>Gespeicherten Stand prüfen</legend>
            <label>
              Kampagne (letzte 50)
              <select value={selected} onChange={(e) => select(e.target.value)}>
                <option value="">Bitte wählen</option>
                {ws.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {states[c.status]} · {c.subject}
                  </option>
                ))}
              </select>
            </label>
            {c && (
              <>
                <h2>{c.subject}</h2>
                <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>
                <p>
                  {topics[c.audience]} · {states[c.status]}
                  {c.scheduled_at && ' · ' + new Date(c.scheduled_at).toLocaleString('de-DE')}
                </p>
                <p>
                  {c.total} Empfänger festgelegt · {c.accepted} vom Mailserver angenommen · {c.suppressed} unterdrückt ·{' '}
                  {c.failed} fehlgeschlagen
                </p>
                <p>
                  {c.audience_size === null
                    ? 'Empfängerzahl wird beim Einfrieren festgelegt.'
                    : `${c.audience_size} bestätigte Adressen in diesem Segment.`}{' '}
                  Die Regel wird unmittelbar vor jeder Übergabe erneut geprüft.
                </p>
                {c.status === 'draft' && (
                  <>
                    <label>
                      Versandzeit (Ortszeit)
                      <input type="datetime-local" value={at} onChange={(e) => F(e.target.value)} />
                    </label>
                    <button
                      disabled={!ws.enabled || !at}
                      onClick={() =>
                        act(
                          `/admin/newsletter/campaigns/${c.id}/schedule`,
                          { scheduled_at: new Date(at).toISOString() },
                          'Versand geplant.',
                        )
                      }
                    >
                      Geprüften Entwurf zum Versand freigeben
                    </button>
                  </>
                )}
                {c.status === 'scheduled' && (
                  <button onClick={() => act(`/admin/newsletter/campaigns/${c.id}/pause`, {}, 'Kampagne angehalten.')}>
                    Geplanten Versand anhalten
                  </button>
                )}
                {c.status === 'paused' && (
                  <button onClick={() => act(`/admin/newsletter/campaigns/${c.id}/resume`, {}, 'Versand wieder geplant.')}>
                    Versand fortsetzen
                  </button>
                )}
                {c.status !== 'cancelled' && (
                  <button onClick={() => act(`/admin/newsletter/campaigns/${c.id}/cancel`, {}, 'Kampagne gestoppt.')}>
                    Kampagne stoppen
                  </button>
                )}
              </>
            )}
            <button onClick={() => load().catch((e) => E(errorMessage(e)))}>Stand aktualisieren</button>
          </fieldset>
          <fieldset disabled={busy} className="dashboard-card stack-form">
            <legend>Dokumentierte Anbietermeldung</legend>
            <label>
              Betroffene Newsletter-Adresse
              <input type="email" value={mail} onChange={(e) => M(e.target.value)} />
            </label>
            <label>
              Grund
              <select value={reason} onChange={(e) => R(e.target.value)}>
                <option value="bounced">Dauerhaft unzustellbar</option>
                <option value="complained">Beschwerde</option>
              </select>
            </label>
            <button
              disabled={!mail.trim()}
              onClick={() =>
                act(
                  '/admin/newsletter/suppress',
                  { email: mail, reason },
                  'Newsletter-Adresse für den Versand gesperrt.',
                )
              }
            >
              Versand an diese Adresse sperren
            </button>
          </fieldset>
          <section className="dashboard-card">
            <h2>Identität für Änderungen bestätigen</h2>
            <Reauth mfa />
          </section>
        </>
      )}
    </div>
  );
}
