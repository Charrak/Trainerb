'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { dateOnly } from '../lib/shop';
import { Field, Notice } from './site';
import { Reauth } from './reauth';

type Entry = { id: string; status: string; title: string; completed_at: string };
const labels: Record<string, string> = {
  queued: 'In Vorbereitung',
  valid: 'Gültig',
  revoked: 'Widerrufen',
  cancelled: 'Beendet',
  unknown: 'Nicht gefunden',
};
export function MyCertificates() {
  const [rows, setRows] = useState<Entry[]>(),
    [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Entry[] }>('/me/certificates')
      .then((r) => setRows(r.data))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  return (
    <div className="account-page content-width">
      <div className="dashboard-title">
        <div>
          <span className="eyebrow">MEIN KONTO</span>
          <h1>Meine Urkunden</h1>
        </div>
        <Link className="button button-secondary" href="/konto">
          Zum Konto
        </Link>
      </div>
      <Notice message={error} />
      <section className="dashboard-card">
        {!rows && !error && <p>Urkunden werden geladen …</p>}
        {rows?.length === 0 && <p>Für dein Konto liegen noch keine Urkunden vor.</p>}
        {rows?.map((row) => (
          <article key={row.id}>
            <h2>{row.title}</h2>
            <p>
              Abgeschlossen am {dateOnly(row.completed_at)} · {labels[row.status]}
            </p>
            {row.status === 'valid' && (
              <a className="button button-primary" href={`/api/v1/me/certificates/${row.id}/download`}>
                Urkunde als PDF herunterladen
              </a>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
export function VerifyCertificate() {
  const [token, setToken] = useState(''),
    [result, setResult] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult('');
    try {
      const res = await fetch('/api/v1/certificates/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok)
        throw new Error(
          res.status === 429
            ? 'Zu viele Anfragen. Bitte versuche es später erneut.'
            : 'Die Prüfung ist derzeit nicht möglich.',
        );
      setResult(labels[(await res.json()).status] ?? 'Nicht gefunden');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Prüfung fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-page content-width">
      <h1>Urkunde prüfen</h1>
      <section className="dashboard-card">
        <p>
          Gib den Prüfcode aus dem PDF ein. Die Abfrage bestätigt den Status des Codes, nicht die Identität der
          vorlegenden Person.
        </p>
        <form className="stack-form" onSubmit={submit}>
          <Field label="Prüfcode" id="verify-code">
            <input
              id="verify-code"
              required
              maxLength={43}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setResult('');
              }}
            />
          </Field>
          <button className="button button-primary" disabled={busy}>
            Gültigkeit prüfen
          </button>
        </form>
        <p role="status">{result}</p>
        <Notice message={error} />
      </section>
    </div>
  );
}

type Template = { id: string; heading: string; issuer: string; approved_at: string | null; course_version_id: string };
type Job = {
  id: string;
  completion_id: string;
  issued_at: string | null;
  status: string;
  last_error: string | null;
  attempts: number;
};
export function AdminCertificates() {
  const [templates, setTemplates] = useState<Template[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [allowed, setAllowed] = useState(false),
    [version, setVersion] = useState('');
  type Page<T> = { data: T[]; next_cursor: string | null };
  const [moreT, setMoreT] = useState<string | null>(null),
    [moreJ, setMoreJ] = useState<string | null>(null);
  async function load() {
    const [t, j] = await Promise.all([
      api<Page<Template>>('/admin/certificate-templates'),
      api<Page<Job>>('/admin/certificates'),
    ]);
    setTemplates(t.data);
    setJobs(j.data);
    setMoreT(t.next_cursor);
    setMoreJ(j.next_cursor);
    setAllowed(true);
  }
  async function more(kind: 'templates' | 'jobs') {
    setBusy(true);
    try {
      if (kind === 'templates') {
        const t = await api<Page<Template>>(`/admin/certificate-templates?before=${moreT}`);
        setTemplates((rows) => [...rows, ...t.data]);
        setMoreT(t.next_cursor);
      } else {
        const j = await api<Page<Job>>(`/admin/certificates?before=${moreJ}`);
        setJobs((rows) => [...rows, ...j.data]);
        setMoreJ(j.next_cursor);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setVersion(new URLSearchParams(window.location.search).get('version') || '');
    load().catch((e) => setError(errorMessage(e)));
  }, []);
  async function change(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await api(path, 'POST', body);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function draft(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    void change('/admin/certificate-templates', {
      course_version_id: version,
      heading: data.get('heading'),
      issuer: data.get('issuer'),
    });
  }
  return (
    <div className="account-page content-width">
      <span className="eyebrow">VERWALTUNG</span>
      <h1>Urkunden</h1>
      <Notice message={error} />
      {allowed && (
        <>
          <section className="dashboard-card">
            <details>
              <summary>Identität für Änderungen bestätigen</summary>
              <Reauth mfa />
            </details>
          </section>
          <section className="dashboard-card">
            <h2>Vorlagenentwurf anlegen</h2>
            <p>
              Name, Kurstitel, Abschlussdatum, Nummer und Prüfcode werden beim Ausstellen ergänzt. Die Freigabe bindet
              den Wortlaut dauerhaft an die Kursversion.
            </p>
            <form className="stack-form" onSubmit={draft}>
              <Field id="cert-version" label="ID des Versionsentwurfs">
                <input id="cert-version" required value={version} onChange={(e) => setVersion(e.target.value)} />
              </Field>
              <Field id="cert-heading" label="Überschrift">
                <input id="cert-heading" name="heading" required maxLength={100} />
              </Field>
              <Field id="cert-issuer" label="Aussteller">
                <input id="cert-issuer" name="issuer" required maxLength={160} />
              </Field>
              <button className="button button-secondary" disabled={busy}>
                Entwurf speichern
              </button>
            </form>
          </section>
          <section className="dashboard-card">
            <h2>Vorlagen</h2>
            {!templates.length && <p>Keine Vorlage vorhanden.</p>}
            {templates.map((t) => (
              <article key={t.id}>
                <h3>{t.heading}</h3>
                <p>
                  {t.issuer} · Version {t.course_version_id}
                </p>
                {t.approved_at ? (
                  <p>Freigegeben am {dateOnly(t.approved_at)}</p>
                ) : (
                  <button
                    className="button button-secondary"
                    disabled={
                      busy || templates.some((x) => x.course_version_id === t.course_version_id && x.approved_at)
                    }
                    onClick={() => void change(`/admin/certificate-templates/${t.id}/approve`, {})}
                  >
                    Wortlaut verbindlich freigeben
                  </button>
                )}
              </article>
            ))}
            {moreT && (
              <button disabled={busy} onClick={() => void more('templates')}>
                Weitere Vorlagen
              </button>
            )}
          </section>
          <section className="dashboard-card">
            <h2>Ausstellungen</h2>
            {!jobs.length && <p>Noch keine Aufträge.</p>}
            {jobs.map((j) => (
              <article key={j.id}>
                <h3>{labels[j.status]}</h3>
                <p>Nr. {j.id}</p>
                {j.last_error && (
                  <p>Erstellung fehlgeschlagen ({j.attempts} Versuche). Der Worker versucht es erneut.</p>
                )}
                {j.status === 'valid' && (
                  <form
                    className="stack-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void change(`/admin/certificates/${j.id}/revoke`, {
                        reason: new FormData(e.currentTarget).get('reason'),
                      });
                    }}
                  >
                    <label>
                      Widerrufsgrund <input name="reason" required maxLength={300} />
                    </label>
                    <button className="button button-outline" disabled={busy}>
                      Urkunde widerrufen
                    </button>
                  </form>
                )}
                {j.status === 'revoked' && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => void change(`/admin/completions/${j.completion_id}/reissue`, { revoked_id: j.id })}
                  >
                    Neuausstellung anfordern
                  </button>
                )}
              </article>
            ))}
            {moreJ && (
              <button disabled={busy} onClick={() => void more('jobs')}>
                Weitere Ausstellungen
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
