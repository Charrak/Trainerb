'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Profile } from '../lib/api';
import { type CourseListItem, type Page, optionalNumber, textValue, visibilityLabels } from '../lib/courses';
import { Arrow, Field, Notice } from './site';

export function AdminCourses() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile>();
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState(''), [slug, setSlug] = useState('');
  const [modules, setModules] = useState(''), [chapters, setChapters] = useState(''), [exams, setExams] = useState('');
  const [mode, setMode] = useState('self_confirm');
  const canCreate = !!profile && profile.permissions.includes('courses.create') && profile.roles.some(role => role === 'admin' || role === 'superadmin');
  async function load(next?: string) {
    setBusy(true); setError('');
    try {
      const page = await api<Page<CourseListItem>>(`/admin/courses${next ? `?cursor=${encodeURIComponent(next)}` : ''}`);
      setCourses(current => next ? [...current, ...page.data] : page.data); setCursor(page.next_cursor); setHasLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setCourses([]); setProfile(undefined); setHasLoaded(false); }
      setError(errorMessage(e));
    } finally { setBusy(false); setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(user => {
      if (!active) return;
      setProfile(user);
      if (user.permissions.includes('courses.read')) void load();
      else { setError('Für diesen Bereich fehlt die Berechtigung.'); setLoading(false); }
    }).catch(e => { if (active) { setError(errorMessage(e)); setLoading(false); } });
    return () => { active = false; };
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const course = await api<{ id: string }>('/admin/courses', 'POST', {
        title, slug, subtitle: textValue(form, 'subtitle'), description: textValue(form, 'description'),
        visibility: textValue(form, 'visibility'), chapter_completion_mode: mode,
        expected_module_count: optionalNumber(form, 'modules'), expected_chapter_count: optionalNumber(form, 'chapters'),
        expected_exams_per_chapter: optionalNumber(form, 'exams'),
      });
      router.push(`/admin/kurse/${course.id}`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  function firstCoursePreset() {
    if (title.trim() || slug.trim() || modules || chapters || exams) {
      if (!window.confirm('Titel, Kennung und geplante Anzahlen durch die Vorgaben ersetzen?')) return;
    }
    setTitle('Fitnesstrainer B-Lizenz'); setSlug('fitnesstrainer-b-lizenz');
    setModules('14'); setChapters('42'); setExams('2'); setMode('all_chapter_exams');
  }
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> GESCHÜTZTE VERWALTUNG</span>
      <h1>Kursentwürfe<span className="accent-dot">.</span></h1><p>Ausbildungen vorbereiten, ohne sie zu veröffentlichen.</p></div>
      <div className="title-actions">{profile?.permissions.includes('products.manage') && <Link className="button button-secondary" href="/admin/produkte">Produkte <Arrow/></Link>}{profile?.permissions.includes('users.read') && <Link className="button button-secondary" href="/admin">Nutzerverwaltung <Arrow/></Link>}
        <Link className="button button-outline" href="/konto">← Mein Konto</Link></div></div>
    <div className="course-feedback"><Notice message={error}/></div>
    {loading ? <p className="muted">Kursentwürfe werden geladen …</p> : profile?.permissions.includes('courses.read') && <div className="admin-grid">
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">ÜBERSICHT</span><h2>Deine Kursentwürfe</h2>
        <p>Kursmanager und Dozenten sehen ausschließlich zugewiesene Kurse.</p></div></div>
        {hasLoaded && !courses.length ? <p className="muted">Noch keine zugänglichen Kursentwürfe vorhanden.</p> : <div className="draft-list">
          {courses.map(course => <Link className="draft-row" key={course.id} href={`/admin/kurse/${course.id}`}>
            <div><strong>{course.draft?.title || 'Kurs ohne Entwurf'}</strong><span>/{course.slug} · {course.status === 'published'
              ? `Veröffentlicht, ${visibilityLabels[course.visibility] || course.visibility}`
              : `Vorgesehen: ${visibilityLabels[course.visibility] || course.visibility}`}{course.needs_draft ? ' · keine Entwurfsversion' : ''}</span></div>
            <span className="draft-row-end"><span className="draft-badge">{course.status === 'draft' ? 'Entwurf' : course.status === 'published' ? 'Veröffentlicht' : course.status}</span><Arrow/></span></Link>)}</div>}
        {cursor && <button className="button button-secondary" disabled={busy} onClick={() => void load(cursor)}>Weitere laden <Arrow/></button>}
        {!hasLoaded && error && <button className="button button-secondary" disabled={busy} onClick={() => void load()}>Erneut laden</button>}
      </section>
      {canCreate && <section className="dashboard-card" id="neu"><div className="section-heading"><div><span className="section-kicker">NEUER ENTWURF</span><h2>Ausbildung anlegen</h2>
        <p>Ein Entwurf ist nicht öffentlich. Freigeben lässt er sich erst nach vollständiger Struktur im Kursdetail; Verkauf und Prüfungen sind eigene Schritte.</p></div></div>
        <button type="button" className="button button-secondary preset-button" disabled={busy} onClick={firstCoursePreset}>Vorgaben für Fitnesstrainer B-Lizenz übernehmen</button>
        <p className="muted">Übernimmt ausschließlich den bekannten Titel und die geplanten Anzahlen 14 / 42 / 2. Es werden keine Module, Lehrinhalte oder Prüfungen erzeugt.</p>
        <form onSubmit={create} className="stack-form"><div className="field-row"><Field label="Titel" id="new-course-title"><input id="new-course-title" name="title" value={title} onChange={e => setTitle(e.target.value)} maxLength={160} required/></Field>
          <Field label="URL-Kennung" id="new-course-slug" hint="Kleinbuchstaben, Zahlen und Bindestriche."><input id="new-course-slug" name="slug" value={slug} onChange={e => setSlug(e.target.value)} maxLength={100} pattern="[a-z0-9]+(-[a-z0-9]+)*" aria-describedby="new-course-slug-hint" required/></Field></div>
          <Field label="Untertitel (optional)" id="new-course-subtitle"><input id="new-course-subtitle" name="subtitle" maxLength={240}/></Field>
          <Field label="Beschreibung (optional)" id="new-course-description"><textarea id="new-course-description" name="description" rows={4} maxLength={8000}/></Field>
          <Field label="Vorgesehene Sichtbarkeit nach späterer Freigabe" id="new-course-visibility" hint="Diese Auswahl veröffentlicht den Entwurf nicht; sie wird erst bei der Freigabe wirksam."><select id="new-course-visibility" name="visibility" defaultValue="private" aria-describedby="new-course-visibility-hint"><option value="private">Privat (nicht veröffentlichbar)</option><option value="unlisted">Nicht gelistet</option><option value="public">Öffentlich</option></select></Field>
          <Field label="Geplante Abschlussregel für Kapitel" id="new-course-mode" hint="Nur Planung: Prüfungen und Abschlusslogik sind noch nicht implementiert."><select id="new-course-mode" name="mode" value={mode} onChange={e => setMode(e.target.value)} aria-describedby="new-course-mode-hint"><option value="self_confirm">Selbst bestätigen</option><option value="all_chapter_exams">Alle Kapitelprüfungen bestehen</option><option value="self_or_all_chapter_exams">Selbst bestätigen oder alle Kapitelprüfungen bestehen</option></select></Field>
          <div className="field-row count-row"><Field label="Module geplant" id="new-course-modules"><input id="new-course-modules" name="modules" type="number" min="1" max="500" value={modules} onChange={e => setModules(e.target.value)}/></Field>
            <Field label="Kapitel geplant" id="new-course-chapters"><input id="new-course-chapters" name="chapters" type="number" min="1" max="5000" value={chapters} onChange={e => setChapters(e.target.value)}/></Field>
            <Field label="Prüfungen je Kapitel geplant" id="new-course-exams"><input id="new-course-exams" name="exams" type="number" min="1" max="100" value={exams} onChange={e => setExams(e.target.value)}/></Field></div>
          <button className="button button-primary" disabled={busy}>{busy ? 'Bitte warten …' : 'Entwurf anlegen'} <Arrow/></button>
        </form></section>}
    </div>}
  </div>;
}
