'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';

const states: Record<string, string> = {
  failed: 'Fehlgeschlagen',
  queued: 'Eingeplant',
  running: 'In Arbeit',
  succeeded: 'Abgeschlossen',
  cancelled: 'Beendet',
  waiting_for_data: 'Wartet auf Daten',
};
type Job = {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
  error_code: string | null;
  retry_candidate: boolean;
};
type Page = { data: Job[]; next_cursor: string | null };
export function MailJobs() {
  const [status, setStatus] = useState('failed'),
    [cursors, setCursors] = useState<string[]>([]),
    [revision, refresh] = useState(0);
  const [page, setPage] = useState<Page>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const before = cursors.at(-1);
  useEffect(() => {
    let active = true;
    setError('');
    setPage(undefined);
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (before) q.set('before', before);
    api<Page>(`/admin/automation-jobs?${q}`)
      .then((p) => {
        if (active) setPage(p);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [status, before, revision]);
  async function retry(job: Job) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/admin/automation-jobs/${job.id}/retry`, 'POST', { expected_attempts: job.attempts });
      setNotice('Ein weiterer Versuch wurde eingeplant. Die Nachricht ist damit noch nicht zugestellt.');
      refresh((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-page content-width">
      <div className="dashboard-title">
        <div>
          <span className="eyebrow">BETRIEB</span>
          <h1>Mailaufträge</h1>
          <p>Versandstatus prüfen, ohne Empfänger oder Mailinhalte zu öffnen.</p>
        </div>
        <Link href="/konto">Zum Konto</Link>
      </div>
      <section className="dashboard-card">
        <label>
          Status{' '}
          <select
            disabled={busy}
            value={status}
            onChange={(e) => {
              setCursors([]);
              setStatus(e.target.value);
              setNotice('');
            }}
          >
            <option value="">Alle</option>
            {Object.entries(states).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="button" disabled={busy} onClick={() => refresh((n) => n + 1)}>
          Aktualisieren
        </button>
        <Notice message={error} />
        <Notice kind="success" message={notice} />
        {!page && !error && <p role="status">Lädt …</p>}
        {page &&
          (page.data.length === 0 ? (
            <p>Keine passenden Mailaufträge.</p>
          ) : (
            <ul>
              {page.data.map((job) => (
                <li key={job.id}>
                  <strong>{states[job.status]}</strong> · Versuch {job.attempts} von {job.max_attempts}
                  <p style={{ overflowWrap: 'anywhere' }}>
                    Auftrag: <code>{job.id}</code>
                    {job.error_code && (
                      <>
                        {' '}
                        · <code>{job.error_code}</code>
                      </>
                    )}
                  </p>
                  {job.status === 'queued' && <p>Frühestens am {new Date(job.run_after).toLocaleString('de-DE')}</p>}
                  {job.retry_candidate && (
                    <button type="button" disabled={busy} onClick={() => retry(job)}>
                      Einen weiteren Versuch einplanen
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ))}
        <nav aria-label="Auftragsseiten">
          <button disabled={busy || !cursors.length} onClick={() => setCursors((c) => c.slice(0, -1))}>
            Zurück
          </button>{' '}
          <button
            disabled={busy || !page?.next_cursor}
            onClick={() => page?.next_cursor && setCursors([...cursors, page.next_cursor])}
          >
            Weitere Aufträge
          </button>
        </nav>
      </section>
      {page?.data.some((j) => j.retry_candidate) && (
        <section className="dashboard-card">
          <h2>Wiederaufnahme bestätigen</h2>
          <p>Zuerst die Fehlerursache beheben. Bei unklarem SMTP-Ergebnis ist keine manuelle Wiederholung möglich.</p>
          <Reauth mfa />
        </section>
      )}
    </div>
  );
}
