'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { dateOnly, type MyCourse } from '../lib/shop';
import { LearnerExam } from './learner-exam';
import { Arrow, Notice } from './site';

type Block = { id: string; kind: string; text?: string; level?: number; items?: string[]; href?: string };
type Content = { id: string; kind: string; title: string | null; media_available?: boolean; body: { schema_version: number; blocks: Block[] } | null };
type Chapter = { access_id: string; exams: { id: string; title: string }[]; can_self_complete: boolean; id: string; title: string; summary: string | null; module_title: string; estimated_minutes: number | null;
  completed_at: string | null; contents: Content[] };
type Course = { course_id: string; slug: string; title: string; subtitle: string | null; duration_minutes: number | null;
  starts_at: string; ends_at: string | null; modules: { id: string; title: string; description: string | null;
    chapters: { id: string; title: string; summary: string | null; estimated_minutes: number | null;
      content_count: number; completed_at: string | null }[] }[] };

/** Lesson blocks are rendered as text, never as HTML. */
function BlockView({ block }: { block: Block }) {
  if (block.kind === 'heading') {
    return block.level && block.level >= 3
      ? <h4 className="lesson-heading">{block.text}</h4> : <h3 className="lesson-heading">{block.text}</h3>;
  }
  if (block.kind === 'list' && block.items) {
    return <ul className="lesson-list">{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
  }
  if (block.kind === 'link' && block.href) {
    return <p><a className="text-link" href={block.href} rel="noopener noreferrer nofollow" target="_blank">{block.text} <Arrow diagonal/></a></p>;
  }
  return <p className="lesson-paragraph">{block.text}</p>;
}

function LessonMedia({ content, src }: { content: Content; src: string }) {
  if (!content.media_available) return <p>Dieses Medium ist derzeit nicht verfügbar.</p>;
  if (content.kind === 'image') return <img src={src} alt={content.title || 'Abbildung zum Kapitel'} style={{ maxWidth: '100%' }}/>;
  if (content.kind === 'video') return <video controls preload="none" src={src} aria-label={content.title || 'Kapitelvideo'} style={{ maxWidth: '100%' }}/>;
  return <a className="text-link" href={src}>Datei herunterladen</a>;
}

export function MyLearning() {
  const [courses, setCourses] = useState<MyCourse[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    api<{ data: MyCourse[] }>('/me/courses').then(value => { if (active) setCourses(value.data); })
      .catch(e => { if (active) setError(e instanceof ApiError && e.status === 401 ? 'Bitte melde dich an.' : errorMessage(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> DEIN LERNBEREICH</span>
      <h1>Meine Ausbildungen<span className="accent-dot">.</span></h1><p>Deine Ausbildungen und der aktuelle Stand deines Zugangs.</p></div>
      <Link className="button button-secondary" href="/konto">← Zum Konto</Link></div>
    <Notice message={error}/>
    {loading ? <p className="muted">Deine Ausbildungen werden geladen …</p> : !courses.length && !error ?
      <section className="dashboard-card"><span className="section-kicker">NOCH KEIN ZUGANG</span><h2>Hier ist es noch leer.</h2>
        <p className="muted">Sobald eine Buchung bezahlt und freigeschaltet ist, erscheint die Ausbildung hier.</p>
        <Link className="text-link" href="/buchen">Angebot ansehen <Arrow/></Link></section> :
      <div className="course-grid">{courses.map(course => {
        const percent = course.chapter_count ? Math.round((course.completed_count / course.chapter_count) * 100) : 0;
        return <article className="course-tile" key={course.course_id}>
          <span className="section-kicker">{course.suspended ? 'ZUGANG VORÜBERGEHEND GESPERRT' : course.ends_at ? `ZUGANG BIS ${dateOnly(course.ends_at).toUpperCase()}` : 'UNBEFRISTETER ZUGANG'}</span>
          <h2>{course.title}</h2>{course.subtitle && <p>{course.subtitle}</p>}
          <p className="course-duration">{course.completed_count} von {course.chapter_count} Kapiteln abgeschlossen ({percent} %)</p>
          {course.suspended ? <p className="muted">Sobald die Sperre aufgehoben ist, kannst du hier weiterlernen.</p> :
            <Link className="text-link" href={`/lernen/${encodeURIComponent(course.slug)}`}>Weiterlernen <Arrow/></Link>}
        </article>;
      })}</div>}
  </div>;
}

export function CoursePlayer({ slug }: { slug: string }) {
  const [course, setCourse] = useState<Course>();
  const [chapter, setChapter] = useState<Chapter>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  async function load() {
    try { setCourse(await api<Course>(`/me/courses/${encodeURIComponent(slug)}`)); }
    catch (e) { setError(e instanceof ApiError && e.status === 404 ? 'Für diese Ausbildung besteht kein Zugang.'
      : errorMessage(e)); }
  }
  useEffect(() => { void load(); }, [slug]);
  async function open(chapterId: string) {
    setBusy(chapterId); setError('');
    try { setChapter(await api<Chapter>(`/me/courses/${encodeURIComponent(slug)}/chapters/${chapterId}`)); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function complete() {
    if (!chapter) return;
    setBusy(chapter.id); setError('');
    try {
      setChapter(await api<Chapter>(`/me/courses/${encodeURIComponent(slug)}/chapters/${chapter.id}/complete`, 'POST', {}));
      await load();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> LERNBEREICH</span>
      <h1>{course?.title ?? 'Ausbildung'}<span className="accent-dot">.</span></h1>
      {course && <p>{course.subtitle}{course.ends_at ? ` · Zugang bis ${dateOnly(course.ends_at)}` : ' · unbefristeter Zugang'}</p>}</div>
      <Link className="button button-secondary" href="/konto/kurse">← Meine Ausbildungen</Link></div>
    <Notice message={error}/>
    {!course ? !error && <p className="muted">Ausbildung wird geladen …</p> : <div className="learning-grid">
      <aside className="learning-outline dashboard-card"><span className="section-kicker">INHALT</span>
        {course.modules.map(module => <div key={module.id} className="outline-module"><h3>{module.title}</h3>
          <ol>{module.chapters.map(item => <li key={item.id}>
            <button type="button" className={`outline-link${chapter?.id === item.id ? ' active' : ''}`}
              disabled={busy === item.id} onClick={() => void open(item.id)}>
              {item.title}{item.completed_at && <span className="outline-done" aria-label="abgeschlossen">✓</span>}</button></li>)}</ol></div>)}
      </aside>
      <section className="dashboard-card learning-content">
        {!chapter ? <><span className="section-kicker">BEREIT</span><h2>Wähle ein Kapitel.</h2>
          <p className="muted">Die Inhalte werden erst nach der Auswahl geladen.</p></> : <>
          <span className="section-kicker">{chapter.module_title.toUpperCase()}</span>
          <h2 className="lesson-title">{chapter.title}</h2>
          {chapter.summary && <p className="public-subtitle">{chapter.summary}</p>}
          {chapter.estimated_minutes && <p className="muted">Richtwert: {chapter.estimated_minutes} Minuten</p>}
          <div className="lesson-body">{chapter.contents.map(content => <div key={content.id} className="lesson-block">
            {content.title && <h3 className="lesson-heading">{content.title}</h3>}
            {content.kind !== 'text' && <LessonMedia content={content} src={`/api/v1/me/courses/${encodeURIComponent(slug)}/chapters/${chapter.id}/media/${content.id}`}/>}
            {content.body?.blocks?.map(block => <BlockView key={block.id} block={block}/>)}
          </div>)}</div>
          {chapter.exams.map(exam => <LearnerExam key={`${chapter.id}/${exam.id}`} exam={exam} access={chapter.access_id} onPass={async () => {
            const current = await api<Chapter>(`/me/courses/${encodeURIComponent(slug)}/chapters/${chapter.id}`);
            setChapter(c => c?.id === current.id ? current : c); await load();
          }}/>) }
          <div className="release-actions">
            {chapter.completed_at ? <p className="publication-ok">Kapitel abgeschlossen am {dateOnly(chapter.completed_at)}.</p>
              : !chapter.can_self_complete ? <p>Das Kapitel wird nach Bestehen aller Kapitelprüfungen abgeschlossen.</p> : <button className="button button-primary" disabled={busy === chapter.id} onClick={() => void complete()}>
                {busy === chapter.id ? 'Bitte warten …' : 'Kapitel abschließen'} <Arrow/></button>}
          </div>
        </>}
      </section>
    </div>}
  </div>;
}
