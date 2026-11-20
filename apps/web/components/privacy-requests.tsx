'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';
const types: Record<string, string> = {
  access: 'Auskunft',
  export: 'Datenübertragung',
  deletion: 'Löschung',
  correction: 'Berichtigung',
};
const states: Record<string, string> = {
  open: 'Neu eingegangen',
  identity_check: 'Identität prüfen',
  in_progress: 'In Bearbeitung',
  completed: 'Abgeschlossen',
  rejected: 'Abgelehnt',
};
export function PrivacyIntake() {
  const [email, E] = useState(''),
    [type, T] = useState('access'),
    [done, D] = useState(false),
    [busy, B] = useState(false),
    [error, X] = useState('');
  return (
    <section className="simple-page content-width">
      <span className="eyebrow">DATENSCHUTZ</span>
      <h1>Meine Datenrechte</h1>
      {done ? (
        <Notice
          kind="success"
          message="Deine Anfrage ist eingegangen. Es wurden keine Daten herausgegeben oder gelöscht."
        />
      ) : (
        <form
          className="stack-form"
          onSubmit={async (e) => {
            e.preventDefault();
            X('');
            B(true);
            try {
              await api('/privacy/requests', 'POST', { email, type });
              E('');
              D(true);
            } catch (e) {
              X(errorMessage(e));
            } finally {
              B(false);
            }
          }}
        >
          <p>
            Auch ohne Konto kannst du eine Anfrage stellen. Wir prüfen deine Identität, bevor wir personenbezogene Daten
            herausgeben oder ändern. Bitte sende hier keine Ausweiskopien.
          </p>
          <label>
            Art der Anfrage
            <select value={type} onChange={(e) => T(e.target.value)}>
              {Object.entries(types).map(([k, t]) => (
                <option key={k} value={k}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Kontaktadresse
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              maxLength={254}
              onChange={(e) => E(e.target.value)}
            />
          </label>
          <Link href="/datenschutz">Datenschutz lesen</Link>
          <Notice message={error} />
          <button className="button button-primary" disabled={busy}>
            Anfrage senden
          </button>
        </form>
      )}
    </section>
  );
}
type Row = { id: string; type: string; status: string; requested_at: string; decision: string | null };
type Results = { data: Row[]; next_cursor: string | null };
const actions: Record<string, string> = {
  begin_identification: 'Identitätsprüfung beginnen',
  identity_verified: 'Identität außerhalb der Plattform geprüft',
  identity_unverified: 'Ablehnen: Identität nicht verifiziert',
  fulfilled: 'Anliegen nach Prüfung erfüllt',
  partially_retained: 'Teilweise erfüllt: Aufbewahrung erforderlich',
  not_applicable: 'Begründet abgelehnt',
};
export function PrivacyDesk() {
  const [state, S] = useState('open'),
    [rows, R] = useState<Results>(),
    [id, I] = useState(''),
    [contact, C] = useState(''),
    [action, A] = useState(''),
    [busy, B] = useState(false),
    [error, X] = useState('');
  const generation = useRef(0);
  async function load(state: string, after?: string) {
    const g = ++generation.current;
    I('');
    C('');
    A('');
    R(undefined);
    X('');
    try {
      const data = await api<Results>('/admin/data-requests?status=' + state + (after ? '&after=' + after : ''));
      if (g === generation.current) R(data);
    } catch (e) {
      if (g === generation.current) X(errorMessage(e));
    }
  }
  useEffect(() => {
    void load(state);
  }, [state]);
  const allowed =
    state === 'open'
      ? ['begin_identification']
      : state === 'identity_check'
        ? ['identity_verified', 'identity_unverified']
        : state === 'in_progress'
          ? ['fulfilled', 'partially_retained', 'not_applicable']
          : [];
  async function run(reveal: boolean) {
    B(true);
    X('');
    try {
      const r = await api<{ email?: string }>(
        `/admin/data-requests/${id}/${reveal ? 'contact' : 'advance'}`,
        'POST',
        reveal ? {} : { action },
      );
      if (reveal) C(r.email ?? '');
      else await load(state);
    } catch (e) {
      X(errorMessage(e));
    } finally {
      B(false);
    }
  }
  return (
    <section className="account-page content-width">
      <span className="eyebrow">DATENSCHUTZ</span>
      <h1>Betroffenenanfragen</h1>
      <Link href="/konto">Zum Konto</Link>
      <Notice message={error} />
      <fieldset className="dashboard-card stack-form" disabled={busy}>
        <legend>Fallbearbeitung</legend>
        <label>
          Fallstand
          <select value={state} onChange={(e) => S(e.target.value)}>
            {Object.entries(states).map(([k, t]) => (
              <option key={k} value={k}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Vorgang auswählen
          <select
            value={id}
            onChange={(e) => {
              I(e.target.value);
              C('');
              A('');
            }}
          >
            <option value="">Bitte wählen</option>
            {rows?.data.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.requested_at).toLocaleDateString('de-DE')} · {types[r.type]} · {r.id}
              </option>
            ))}
          </select>
        </label>
        {rows?.data.length === 0 && <p>Keine Vorgänge in diesem Fallstand.</p>}
        {rows?.next_cursor && <button onClick={() => load(state, rows.next_cursor!)}>Weitere Vorgänge</button>}
        {id && allowed.length > 0 && (
          <>
            <button onClick={() => (contact ? C('') : run(true))}>
              {contact ? 'Kontakt ausblenden' : 'Kontaktadresse protokolliert anzeigen'}
            </button>
            {contact && <p>{contact}</p>}
            <p>
              Ein Fallabschluss dokumentiert das Ergebnis. Er erstellt keinen Export und löscht kein Konto. Vor
              Abschluss alle betroffenen Systeme, Aufbewahrungsgründe und Dienstleister prüfen und das Ergebnis sicher
              mitteilen.
            </p>
            <label>
              Durchgeführten Schritt dokumentieren
              <select value={action} onChange={(e) => A(e.target.value)}>
                <option value="">Bitte wählen</option>
                {allowed.map((k) => (
                  <option key={k} value={k}>
                    {actions[k]}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={!action} onClick={() => run(false)}>
              Schritt verbindlich speichern
            </button>
          </>
        )}
        {id && !allowed.length && (
          <p>
            Entscheidung: {actions[rows?.data.find((r) => r.id === id)?.decision ?? '']}. Die Kontaktadresse wurde aus
            der Fallakte entfernt.
          </p>
        )}
      </fieldset>
      <section className="dashboard-card">
        <h2>Identität für Fallzugriff bestätigen</h2>
        <Reauth mfa />
      </section>
    </section>
  );
}
