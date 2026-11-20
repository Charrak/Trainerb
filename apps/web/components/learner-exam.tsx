'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { Notice } from './site';

type Attempt = { id: string; status: 'in_progress'; questions: { id: string; text: string; options: { id: string; text: string }[] }[] }
  | { id: string; status: 'failed' } | { id: string; status: 'passed'; solutions: {text: string; answer: string; explanation: string}[] };
type Wait = { retry_at: string; retry_after_ms: string };
export function LearnerExam({ access, exam, onPass }: { access: string; exam: {id: string; title: string}; onPass: () => Promise<void> }) {
  const base = `/enrollments/${access}/exams/${exam.id}/attempts`;
  const [attempt,setAttempt] = useState<Attempt | null>(), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [wait, setWait] = useState<(Wait & { early: boolean }) | null>(null);
  useEffect(() => {
    if (!wait) return;
    const timer = setTimeout(() => setWait(null), Number(wait.retry_after_ms));
    return () => clearTimeout(timer);
  }, [wait]);
  const startKey = useRef(''), submitKey = useRef('');
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); try { await work(); } catch (e) {
      if (e instanceof ApiError && ['EXAM_COOLDOWN', 'EXAM_TOO_EARLY'].includes(e.code) &&
          e.details?.retry_at && e.details.retry_after_ms) {
        setWait({retry_at:e.details.retry_at, retry_after_ms:e.details.retry_after_ms, early:e.code === 'EXAM_TOO_EARLY'});
      } else setError(errorMessage(e));
    } finally { setBusy(false); }
  }
  async function loadCurrent() {
    const stored = await api<{attempt: Attempt | null; cooldown?: Wait}>(`${base}/current`);
    setAttempt(stored.attempt); setWait(stored.cooldown ? {...stored.cooldown, early:false} : null);
  }
  function resume() { return run(loadCurrent); }
  async function start() {
    await run(async () => {
      startKey.current ||= crypto.randomUUID();
      setAttempt(await api<Attempt>(base, 'POST', {}, startKey.current)); startKey.current = ''; submitKey.current = '';
    });
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (attempt?.status !== 'in_progress') return;
    const data = new FormData(e.currentTarget);
    const answers = attempt.questions.map(q => ({ question_id: q.id, option_id: data.get(q.id) }));
    await run(async () => {
      submitKey.current ||= crypto.randomUUID();
      const result = await api<Attempt>(`${base}/${attempt.id}/submit`, 'POST', { answers }, submitKey.current);
      setAttempt(result); submitKey.current = '';
      if (result.status === 'passed') await onPass();
      else if (result.status === 'failed') await loadCurrent();
    });
  }
  return <details className="editor-details" onToggle={e => { if (e.currentTarget.open && attempt === undefined && !busy) void resume(); }}>
    <summary>Prüfung: {exam.title}</summary><Notice message={error}/>
    {wait && <p role="status">{wait.early ? 'Die Mindestbearbeitungszeit läuft noch. Abgabe möglich ab ' : 'Nach den Fehlversuchen ist eine Pause nötig. Nächster Versuch ab '}
      <time dateTime={wait.retry_at}>{new Date(wait.retry_at).toLocaleString('de-DE', {dateStyle:'medium', timeStyle:'medium'})}</time> (deine Ortszeit).</p>}
    {error && <button type="button" disabled={busy} onClick={() => void resume()}>Gespeicherten Stand laden</button>}
    {attempt?.status === 'failed' && <p>Prüfung nicht bestanden.</p>}
    {(attempt === null || attempt?.status === 'failed') && <><p>Drei Fragen mit je einer richtigen Antwort. Zum Bestehen müssen alle drei richtig sein.</p>
      <button className="button button-primary" disabled={busy || !!wait} onClick={() => void start()}>{attempt ? 'Erneut versuchen' : 'Prüfung starten'}</button></>}
    {attempt?.status === 'in_progress' && <form key={attempt.id} onSubmit={submit} className="stack-form">
      {attempt.questions.map((q,i) => <fieldset key={q.id} disabled={busy}><legend>{i+1}. {q.text}</legend>
        {q.options.map(o => <label key={o.id}><input type="radio" required name={q.id} value={o.id}/> {o.text}</label>)}
      </fieldset>)}<button className="button button-primary" disabled={busy || !!wait}>Antworten verbindlich abgeben</button></form>}
    {attempt?.status === 'passed' && <><p className="publication-ok">Prüfung bestanden.</p><h4>Lösungen deines Versuchs</h4>
      {attempt.solutions.map((s,i) => <div key={i}><strong>{s.text}</strong><p>{s.answer}</p><p>{s.explanation}</p></div>)}</>}
  </details>;
}
