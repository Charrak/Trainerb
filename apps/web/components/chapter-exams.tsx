'use client';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';

type Exam = { id: string; title: string };
type Question = { id: string; revision: number; status: string; question_text: string; explanation: string;
  options: { option_text: string; is_correct: boolean }[] };

export function ChapterExams({ chapterId, disabled, canApprove, onAccessLost }: {
  chapterId: string; disabled: boolean; canApprove: boolean; onAccessLost: (error: unknown) => void;
}) {
  const base = `/admin/course-chapters/${chapterId}/exams`;
  const [exams, setExams] = useState<Exam[]>(), [exam, setExam] = useState('');
  const [questions, setQuestions] = useState<Question[]>(), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState('');
  const q = questions?.find(item => item.id === selected);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(''); setNote('');
    try { await work(); } catch (e) { setError(errorMessage(e)); onAccessLost(e); } finally { setBusy(false); }
  }
  async function choose(id: string) {
    setExam(id); setSelected(''); setQuestions(undefined);
    if (id) setQuestions(await api<Question[]>(`${base}/${id}/questions`));
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, title = new FormData(form).get('title');
    await action(async () => {
      const saved = await api<Exam>(base, 'POST', { title });
      setExams(current => [...(current ?? []), saved]); form.reset(); await choose(saved.id);
      setNote('Prüfung und Fragenpool im Kapitelentwurf angelegt.');
    });
  }
  async function refresh(id: string) {
    setQuestions(await api<Question[]>(`${base}/${exam}/questions`)); setSelected(id);
  }
  return <details className="editor-details" onToggle={e => {
    if (e.currentTarget.open && !exams && !busy) void action(async () => setExams(await api<Exam[]>(base)));
  }}><summary>Kapitelprüfungen und Fragen</summary>
    <p>Nur für die Redaktion. Freigegebene Fragen sind schreibgeschützt. Eine Freigabe veröffentlicht keine Prüfung.</p>
    <Notice message={error}/><Notice kind="success" message={note}/>
    <fieldset disabled={busy || disabled}>
      {!exams ? <button type="button" onClick={() => void action(async () => setExams(await api<Exam[]>(base)))}>Prüfungen laden</button> : <>
        <form onSubmit={create} className="stack-form"><label>Neue Kapitelprüfung<input name="title" maxLength={160} required/></label>
          <button className="button button-secondary">Prüfung anlegen</button></form>
        <label>Prüfung auswählen<select value={exam} onChange={e => { const id = e.target.value; void action(() => choose(id)); }}>
          <option value="">Bitte auswählen</option>{exams.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label></>}
      {exam && <button type="button" onClick={() => { if (window.confirm('Fragen neu laden und ungespeicherte Eingaben verwerfen?')) void action(() => choose(exam)); }}>Fragen neu laden</button>}
      {questions && <><label>Frage auswählen<select value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">Neue Frage</option>{questions.map(item => <option key={item.id} value={item.id}>{item.status === 'draft' ? 'Entwurf' : 'Geprüft'}: {item.question_text}</option>)}
      </select></label><QuestionForm key={`${exam}/${q?.id ?? 'new'}/${q?.revision ?? 0}`} question={q} canApprove={canApprove}
        onSave={body => action(async () => {
          const url = `${base}/${exam}/questions`;
          const saved = await api<{ id: string }>(q ? `${url}/${q.id}` : url, q ? 'PUT' : 'POST', body);
          await refresh(saved.id); setNote('Fragenentwurf gespeichert.');
        })} onApprove={() => action(async () => {
          if (!q) return;
          await api(`${base}/${exam}/questions/${q.id}/approve`, 'POST', { revision: q.revision });
          await refresh(q.id); setNote('Frage fachlich freigegeben.');
        })}/>
        {canApprove && q?.status === 'draft' && <details><summary>Identität für die Freigabe bestätigen</summary><Reauth mfa idPrefix={`question-${q.id}`}/></details>}</>}
    </fieldset></details>;
}

function QuestionForm({ question: q, canApprove, onSave, onApprove }: { question?: Question; canApprove: boolean;
  onSave: (body: unknown) => Promise<void>; onApprove: () => Promise<void> }) {
  const [dirty, setDirty] = useState(false);
  const locked = !!q && q.status !== 'draft';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const options = Array.from({ length: 4 }, (_, i) => ({ option_text: String(form.get(`option${i}`) ?? '').trim(), is_correct: form.get('correct') === String(i) }))
      .filter(option => option.option_text || option.is_correct);
    await onSave({ question_text: form.get('question'), explanation: form.get('explanation'), options, ...(q ? { revision: q.revision } : {}) });
  }
  return <><form onSubmit={submit} onChange={() => setDirty(true)} className="stack-form"><fieldset disabled={locked}>
    <label>Fragetext<textarea name="question" defaultValue={q?.question_text} maxLength={2000} required/></label>
    <label>Erklärung der Lösung<textarea name="explanation" defaultValue={q?.explanation} maxLength={4000}/></label>
    <p>Im Entwurf können Antworten und Erklärung fehlen. Für die Freigabe alle vier Antworten ausfüllen und eine als richtig markieren.</p>
    {Array.from({ length: 4 }, (_, i) => <div key={i}><label>Antwort {i + 1}<input name={`option${i}`} maxLength={500} defaultValue={q?.options[i]?.option_text}/></label>
      <label><input type="radio" name="correct" value={i} defaultChecked={q?.options[i]?.is_correct}/> Antwort {i + 1} ist richtig</label></div>)}
    <label><input type="radio" name="correct" value="" defaultChecked={!q?.options.some(o => o.is_correct)}/> Noch keine richtige Antwort festgelegt</label>
    {!locked && <button className="button button-secondary">Entwurf speichern</button>}</fieldset></form>
    {!locked && q && canApprove && <button type="button" className="button button-secondary" disabled={dirty}
      onClick={() => { if (window.confirm('Gespeicherte Frage, Lösung und Erklärung fachlich geprüft und freigeben?')) void onApprove(); }}>Gespeicherte Frage freigeben</button>}
  </>;
}
