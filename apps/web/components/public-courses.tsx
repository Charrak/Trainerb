'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Arrow, Notice } from './site';

export type PublicCourse = { slug: string; title: string; subtitle: string | null; description: string; duration_minutes: number | null };
type CoursePage = { data: PublicCourse[]; next_cursor: string | null };

export function PublicCourses() {
  const [courses, setCourses] = useState<PublicCourse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(next?: string) {
    setBusy(true); setError('');
    try {
      const page = await api<CoursePage>(`/courses${next ? `?cursor=${encodeURIComponent(next)}` : ''}`);
      setCourses(previous => next ? [...previous, ...page.data] : page.data);
      setCursor(page.next_cursor);
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <div className="catalog-page content-width">
    <div className="catalog-hero"><div><span className="eyebrow"><span className="eyebrow-line"/> WISSEN, DAS WEITERBRINGT</span>
      <h1>Ausbildungen<span className="accent-dot">.</span></h1><p>Hier stehen die freigegebenen Ausbildungen der Akademie.</p></div>
      <span className="draft-badge">Akademie im Aufbau</span></div>
    <Notice message={error}/>
    {loading ? <p className="muted">Ausbildungen werden geladen …</p> : !error && !courses.length ?
      <section className="catalog-empty"><span className="section-kicker">NOCH IN VORBEREITUNG</span><h2>Hier entsteht etwas Neues.</h2>
        <p>Derzeit ist keine Ausbildung veröffentlicht. Kurse erscheinen hier erst nach vollständiger Prüfung und ausdrücklicher Freigabe.</p>
        <Link className="text-link" href="/registrieren">Konto erstellen <Arrow/></Link></section> :
      <div className="course-grid">{courses.map(course => <article className="course-tile" key={course.slug}>
        <span className="section-kicker">AUSBILDUNG</span><h2>{course.title}</h2>{course.subtitle && <p>{course.subtitle}</p>}
        {course.duration_minutes !== null && <p className="course-duration">Umfang: {course.duration_minutes} Minuten</p>}
        <Link className="text-link" href={`/kurse/${encodeURIComponent(course.slug)}`}>Mehr erfahren <Arrow/></Link></article>)}</div>}
    {cursor && <button className="button button-secondary" disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Bitte warten …' : 'Weitere Ausbildungen laden'} <Arrow/></button>}
    {error && <button className="button button-secondary" disabled={busy} onClick={() => void load()}>Erneut versuchen</button>}
  </div>;
}

export function PublicCourseDetail({ course }: { course: PublicCourse }) {
  return <div className="catalog-page content-width"><Link className="back-link" href="/kurse">← Alle Ausbildungen</Link>
    <article className="public-detail"><span className="eyebrow"><span className="eyebrow-line"/> AUSBILDUNG</span><h1>{course.title}<span className="accent-dot">.</span></h1>
        {course.subtitle && <p className="public-subtitle">{course.subtitle}</p>}
        {course.duration_minutes !== null && <p className="course-duration">Umfang: {course.duration_minutes} Minuten</p>}
        {course.description && <div className="public-description">{course.description}</div>}
        <p className="muted">Ob eine Buchung möglich ist, steht im Bereich <Link className="text-link" href="/buchen">Buchen</Link>.</p></article>
  </div>;
}
