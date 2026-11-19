'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';

type Event = {
  id: string;
  created_at: string;
  action: string;
  origin: string;
  target_type: string;
  target_id: string | null;
};
type Page = { data: Event[]; next_cursor: string | null };
const origins: Record<string, string> = {
  user: 'Benutzeraktion',
  system: 'System',
  provider: 'Dienstleister',
  bootstrap: 'Ersteinrichtung',
};

const actions: Record<string, string> = {
  'certificate.issued': 'Urkunde ausgestellt',
  'certificate.revoked': 'Urkunde widerrufen',
  'certificate.reissue_requested': 'Neuausstellung angefordert',
  'certificate_template.created': 'Vorlage angelegt',
  'certificate_template.approved': 'Vorlage freigegeben',
};

export function AuditLog() {
  const [scope, setScope] = useState('');
  // Keep only the current page of sensitive data, not an unbounded log in client memory.
  const [history, setHistory] = useState<string[]>([]);
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState('');
  const before = history.at(-1);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams();
    if (scope) query.set('scope', scope);
    if (before) query.set('before', before);
    api<Page>(`/admin/audit-events?${query}`)
      .then((p) => {
        if (active) setPage(p);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [scope, before]);
  function navigate(cursors: string[], nextScope = scope) {
    setPage(undefined);
    setError('');
    setHistory(cursors);
    setScope(nextScope);
  }
  return (
    <div className="account-page content-width">
      <div className="dashboard-title">
        <div>
          <span className="eyebrow">GESCHÜTZTE VERWALTUNG</span>
          <h1>Auditprotokoll</h1>
          <p>Protokollierte Aktionen nachverfolgen. Einträge lassen sich hier nicht ändern.</p>
        </div>
        <Link className="button button-secondary" href="/konto">
          Zum Konto
        </Link>
      </div>
      <section className="dashboard-card">
        <label>
          Bereich{' '}
          <select value={scope} onChange={(e) => navigate([], e.target.value)}>
            <option value="">Alle Bereiche</option>
            <option value="certificates">Urkunden und Vorlagen</option>
          </select>
        </label>
        <Notice message={error} />
        {!page && !error && <p role="status">Einträge werden geladen …</p>}
        {page && (
          <>
            {page.data.length === 0 ? (
              <p>Keine Einträge in diesem Bereich.</p>
            ) : (
              <ol>
                {page.data.map((event) => (
                  <li key={event.id}>
                    <article>
                      <strong>{actions[event.action] ?? event.action}</strong>
                      {actions[event.action] && (
                        <>
                          {' '}
                          · <code>{event.action}</code>
                        </>
                      )}
                      <p>
                        <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString('de-DE')}</time> ·{' '}
                        {origins[event.origin] ?? event.origin}
                      </p>
                      <p style={{ overflowWrap: 'anywhere' }}>
                        Ziel: {event.target_type}
                        {event.target_id && (
                          <>
                            {' '}
                            · <code>{event.target_id}</code>
                          </>
                        )}
                      </p>
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        <nav aria-label="Protokollseiten">
          <button type="button" disabled={!history.length} onClick={() => navigate(history.slice(0, -1))}>
            Zurück
          </button>{' '}
          <button
            type="button"
            disabled={!page?.next_cursor}
            onClick={() => page?.next_cursor && navigate([...history, page.next_cursor])}
          >
            Weitere Einträge
          </button>
        </nav>
      </section>
    </div>
  );
}
