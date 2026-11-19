'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Profile } from '../lib/api';
import { descriptionText, editableDescription, modeLabels, nextPosition, optionalNumber, textValue, visibilityLabels,
  type Chapter, type CourseDetail, type CourseMutate, type Module, type Page, type Version } from '../lib/courses';
import { Arrow, Field, Notice } from './site';
import { Reauth } from './reauth';
import { ChapterExams } from './chapter-exams';
import { ChapterContents } from './chapter-contents';
import { CoursePublication } from './publication-panel';

type Mutate = CourseMutate;
type User = { id: string; first_name: string; last_name: string; email: string; status: string; roles: string[] };
const lostAccess = (error: unknown) => error instanceof ApiError &&
  (error.status === 401 || error.status === 404 || (error.status === 403 && ['FORBIDDEN', 'MFA_REQUIRED'].includes(error.code)));

export function AdminCourseDetail({ id }: { id: string }) {
  const [profile, setProfile] = useState<Profile>();
  const [course, setCourse] = useState<CourseDetail>();
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [outdated, setOutdated] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [contentConflict, setContentConflict] = useState<string | null>(null);
  async function reload() {
    setBusy(true); setError(''); setMessage(''); setContentConflict(null);
    try { setCourse(await api<CourseDetail>(`/admin/courses/${encodeURIComponent(id)}`)); setReloadKey(value => value + 1); setOutdated(false); }
    catch (e) { if (lostAccess(e)) setCourse(undefined); setOutdated(true); setError(errorMessage(e)); }
    finally { setBusy(false); setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(async user => {
      if (!active) return;
      setProfile(user);
      if (!user.permissions.includes('courses.read')) { setError('Für diesen Bereich fehlt die Berechtigung.'); setLoading(false); return; }
      try { const value = await api<CourseDetail>(`/admin/courses/${encodeURIComponent(id)}`); if (active) setCourse(value); }
      catch (e) { if (active) setError(errorMessage(e)); }
      finally { if (active) setLoading(false); }
    }).catch(e => { if (active) { setError(errorMessage(e)); setLoading(false); } });
    return () => { active = false; };
  }, [id]);
  const mutate: Mutate = async (path, method, body, success, chapterId) => {
    setBusy(true); setError(''); setMessage(''); setContentConflict(null);
    try {
      const value = await api(path, method, body);
      setMessage(success);
      try { setCourse(await api<CourseDetail>(`/admin/courses/${encodeURIComponent(id)}`)); setOutdated(false); }
      catch (e) { if (lostAccess(e)) setCourse(undefined); setOutdated(true); setError('Die Änderung wurde gespeichert, aber der aktuelle Stand konnte nicht geladen werden. Bitte lade den Entwurf neu.'); }
      return { ok: true, value };
    } catch (e) {
      if (lostAccess(e)) { setCourse(undefined); setOutdated(true); }
      setContentConflict(path.startsWith('/admin/chapter-contents/') && e instanceof ApiError && e.code === 'STALE_DRAFT' ? chapterId || null : null);
      setError(errorMessage(e)); return { ok: false };
    } finally { setBusy(false); }
  };
  function handleContentReadError(error: unknown) {
    if (lostAccess(error)) { setCourse(undefined); setOutdated(true); setError(errorMessage(error)); }
  }
  function handleContentRefreshed(chapterId: string) {
    if (contentConflict === chapterId) { setError(''); setContentConflict(null); }
  }
  const canEdit = !!profile?.permissions.includes('courses.edit');
  const canPublish = !!profile && profile.permissions.includes('courses.publish') &&
    profile.roles.some(role => role === 'admin' || role === 'superadmin');
  const canAssign = !!profile && profile.permissions.includes('courses.create') && profile.roles.some(role => role === 'admin' || role === 'superadmin');
  const version = course?.versions[0];
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> GESCHÜTZTER ENTWURF</span>
      <h1>{version?.title || 'Kursentwurf'}<span className="accent-dot">.</span></h1>
      <p>{course ? `/${course.slug} · Vorgesehene Sichtbarkeit: ${visibilityLabels[course.visibility] || course.visibility}` : 'Kursverwaltung'}</p></div>
      <div className="title-actions"><Link className="button button-outline" href="/admin/kurse">← Alle Entwürfe</Link></div></div>
    <div className="course-feedback"><Notice message={error}/><Notice kind="success" message={message}/>
      {error && profile?.permissions.includes('courses.read') && <button className="button button-secondary reload-button" disabled={busy} onClick={() => {
        if (window.confirm('Den gesamten Entwurf neu laden? Nicht gespeicherte Änderungen können dabei verloren gehen.')) void reload();
      }}>Entwurf neu laden</button>}</div>
    {loading ? <p className="muted">Entwurf wird geladen …</p> : !course ? <p className="muted">Der Entwurf ist nicht verfügbar oder du hast keinen Zugriff.</p> : <div className="admin-grid">
      <div className="future-note"><span>{course.status === 'published' ? 'VERÖFFENTLICHT' : 'NICHT VERÖFFENTLICHT'}{version ? ` · VERSION ${version.version}` : ''}</span>
        <strong>{course.status === 'published' ? 'Im Katalog sichtbar, noch nicht verkäuflich.' : 'Ein sicherer Platz zum Vorbereiten.'}</strong>
        <p>{course.status === 'published'
          ? 'Die veröffentlichte Fassung ist unveränderlich. Änderungen laufen über eine neue Entwurfsversion. Verkauf und Lernzugang hängen an Produkten; Zertifikate sind noch nicht verfügbar.'
          : version ? 'Veröffentlichung ist nach erfüllten Voraussetzungen und frischer Bestätigung möglich; Zertifikate sind noch nicht verfügbar.'
            : 'Es gibt derzeit keine bearbeitbare Entwurfsversion. Lege im Freigabebereich eine neue Entwurfsversion an.'}</p></div>
      {version ? <>
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">GRUNDLAGEN</span><h2>Kursangaben</h2>
        <p>Geplant: {version.expected_module_count ?? '–'} Module · {version.expected_chapter_count ?? '–'} Kapitel · {version.expected_exams_per_chapter ?? '–'} Prüfungen je Kapitel.</p></div><span className="draft-badge">Entwurf</span></div>
        {canEdit ? <VersionForm key={`${version.id}:${version.revision}:${reloadKey}`} version={version} disabled={busy || outdated} mutate={mutate}/> :
          <div className="readonly-draft"><p className="muted">Du hast nur Lesezugriff.</p>{version.subtitle && <p>{version.subtitle}</p>}
            {descriptionText(version.description) && <p className="module-description">{descriptionText(version.description)}</p>}
            <p>Geplante Abschlussregel: {modeLabels[version.chapter_completion_mode] || version.chapter_completion_mode}</p></div>}
      </section>
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">STRUKTUR</span><h2>Module & Kapitel</h2>
        <p>{version.modules.length} Module · {version.modules.reduce((sum, item) => sum + item.chapters.length, 0)} Kapitel angelegt. Positionen müssen innerhalb derselben Ebene eindeutig sein.</p></div></div>
        {version.modules.length === 0 && <p className="muted">Noch keine Module angelegt.</p>}
        <div className="module-list">{version.modules.map(item => <ModuleEditor key={`${item.id}:${reloadKey}`} item={item} disabled={busy || outdated} canApprove={canPublish} canEdit={canEdit} mutate={mutate} onContentReadError={handleContentReadError} onContentRefreshed={handleContentRefreshed}/>)}</div>
        {canEdit && <AddModule key={reloadKey} version={version} disabled={busy || outdated} mutate={mutate}/>}
      </section>
      </> : null}
      {profile?.permissions.includes('media.upload') && <QuarantineUpload key={course.id} courseId={course.id} mutate={mutate} disabled={busy || outdated}/>}
      <ScanResults uploads={course.quarantine_uploads} courseId={course.id} canApprove={canPublish} disabled={busy || outdated} mutate={mutate}/>
      <CoursePublication courseId={course.id} version={version && { id: version.id, revision: version.revision, version: version.version }}
        canPublish={canPublish} onChanged={() => void reload()}/>
      {canAssign && <Staff course={course} canReadUsers={profile?.permissions.includes('users.read') || false} disabled={busy || outdated} mutate={mutate}/>}
    </div>}
  </div>;
}

function QuarantineUpload({ courseId, mutate, disabled }: { courseId: string; mutate: Mutate; disabled: boolean }) {
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    const file = new FormData(form).get('file');
    if (!(file instanceof File) || !file.size || file.size > 5 * 1024 * 1024) { setError('Bitte eine Datei bis 5 MiB auswählen.'); return; }
    setError('');
    const saved = await mutate(`/admin/courses/${courseId}/media/uploads`, 'POST', file, 'Datei in Quarantäne gespeichert. Sie ist nicht freigegeben.');
    if (saved.ok) form.reset();
  }
  return <section className="dashboard-card"><h2>Datei in Quarantäne hochladen</h2>
    <p>PNG, JPEG oder PDF bis 5 MiB. Die Datei bleibt privat und kann noch nicht im Kurs verwendet werden.</p>
    <form className="stack-form" onSubmit={submit}><Field id="course-upload" label="Datei"><input type="file" id="course-upload" name="file"
      accept=".png,.jpg,.jpeg,.pdf" required disabled={disabled}/></Field><Notice message={error}/>
      <button className="button button-secondary" disabled={disabled}>In Quarantäne hochladen</button></form></section>;
}

function ScanResults({ uploads, courseId, canApprove, disabled, mutate }: { uploads: CourseDetail['quarantine_uploads']; courseId: string; canApprove: boolean; disabled: boolean; mutate: Mutate }) {
  if (!uploads.length) return null;
  const statuses: Record<string, string> = { pending_scan: 'Wartet auf Prüfung', clean: 'Ohne Fund – weiterhin privat',
    infected: 'Fund – gesperrt', scan_error: 'Prüffehler – gesperrt' };
  const errors: Record<string, string> = { storage: 'Objekt nicht lesbar', integrity: 'Größe oder Prüfsumme weicht ab', scanner: 'Kein gültiges Prüfergebnis' };
  return <section className="dashboard-card"><h2>Prüfergebnisse</h2><p>Die letzten 25 Uploads dieses Kurses. Für neue Ergebnisse die Seite neu laden.</p>
    <ul>{uploads.map(row => <li key={row.id}><strong>{row.original_name}</strong>: {statuses[row.status] ?? 'Unbekannt – gesperrt'}
      {row.scan_error && ` (${errors[row.scan_error] ?? 'Prüfung fehlgeschlagen'})`}{row.scanned_at && ` · ${new Date(row.scanned_at).toLocaleString('de-DE')}`}
      {row.scan_error && <small> · Beleg {row.id}</small>}
      {row.promoted_asset_id ? <strong> · Als privates Kursmedium übernommen</strong>
        : row.promotion_error ? <strong> · Übernahme fehlgeschlagen ({row.promotion_error === 'destination' ? 'Zielspeicher' : errors[row.promotion_error]}), Beleg {row.id}</strong>
        : row.approved_at ? <strong> · Redaktionell freigegeben am {new Date(row.approved_at).toLocaleString('de-DE')} – noch nicht übernommen</strong>
        : canApprove && row.status === 'clean' && <button className="button button-secondary" disabled={disabled} onClick={() => {
          if (window.confirm(`„${row.original_name}“ für die spätere Übernahme als privates Kursmedium freigeben?`))
            void mutate(`/admin/courses/${courseId}/media/uploads/${row.id}/approve`, 'POST', {}, 'Freigabe gespeichert. Die Datei bleibt in Quarantäne.');
        }}>Für Übernahme freigeben</button>}</li>)}</ul>
    {canApprove && uploads.some(row => row.status === 'clean' && !row.approved_at) && <details><summary>Identität für die Freigabe bestätigen</summary>
      <Reauth mfa idPrefix="media-approval"/></details>}</section>;
}

function VersionForm({ version, disabled, mutate }: { version: Version; disabled: boolean; mutate: Mutate }) {
  const canEditDescription = editableDescription(version.description);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await mutate(`/admin/course-versions/${version.id}`, 'PATCH', { revision: version.revision, title: textValue(form, 'title'),
      subtitle: textValue(form, 'subtitle'), ...(canEditDescription ? { description: textValue(form, 'description') } : {}), chapter_completion_mode: textValue(form, 'mode'),
      expected_module_count: optionalNumber(form, 'modules'), expected_chapter_count: optionalNumber(form, 'chapters'),
      expected_exams_per_chapter: optionalNumber(form, 'exams') }, 'Kursangaben gespeichert.');
  }
  return <form className="stack-form" onSubmit={submit}>
    <div className="field-row"><Field label="Titel" id="course-title"><input id="course-title" name="title" defaultValue={version.title} maxLength={160} required/></Field>
      <Field label="Untertitel (optional)" id="course-subtitle"><input id="course-subtitle" name="subtitle" defaultValue={version.subtitle || ''} maxLength={240}/></Field></div>
    {canEditDescription ? <Field label="Beschreibung (optional)" id="course-description"><textarea id="course-description" name="description" defaultValue={descriptionText(version.description)} maxLength={8000} rows={4}/></Field> :
      <p className="muted">Die Beschreibung enthält ein noch nicht unterstütztes Format und wird hier nicht verändert.</p>}
    <Field label="Geplante Abschlussregel für Kapitel" id="course-mode" hint="Eine Planung, keine aktive Prüfungsfunktion."><select id="course-mode" name="mode" defaultValue={version.chapter_completion_mode} aria-describedby="course-mode-hint"><option value="self_confirm">Selbst bestätigen</option><option value="all_chapter_exams">Alle Kapitelprüfungen bestehen</option><option value="self_or_all_chapter_exams">Selbst bestätigen oder alle Kapitelprüfungen bestehen</option></select></Field>
    <div className="field-row count-row"><Field label="Module geplant" id="course-modules"><input id="course-modules" name="modules" type="number" min="1" max="500" defaultValue={version.expected_module_count ?? ''}/></Field>
      <Field label="Kapitel geplant" id="course-chapters"><input id="course-chapters" name="chapters" type="number" min="1" max="5000" defaultValue={version.expected_chapter_count ?? ''}/></Field>
      <Field label="Prüfungen je Kapitel geplant" id="course-exams"><input id="course-exams" name="exams" type="number" min="1" max="100" defaultValue={version.expected_exams_per_chapter ?? ''}/></Field></div>
    <button className="button button-primary" disabled={disabled}>Kursangaben speichern <Arrow/></button>
  </form>;
}

function AddModule({ version, disabled, mutate }: { version: Version; disabled: boolean; mutate: Mutate }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget, form = new FormData(element);
    if ((await mutate(`/admin/course-versions/${version.id}/modules`, 'POST', { title: textValue(form, 'title'),
      description: textValue(form, 'description'), position: Number(form.get('position')) }, 'Modul angelegt.')).ok) element.reset();
  }
  return <details className="editor-details add-details"><summary>+ Modul hinzufügen</summary><form className="stack-form editor-form" onSubmit={submit}>
    <Field label="Modultitel" id="new-module-title"><input id="new-module-title" name="title" maxLength={160} required/></Field>
    <Field label="Beschreibung (optional)" id="new-module-description"><textarea id="new-module-description" name="description" rows={3} maxLength={4000}/></Field>
    <Field label="Position" id="new-module-position"><input id="new-module-position" name="position" type="number" min="0" max="100000" defaultValue={nextPosition(version.modules)} required/></Field>
    <button className="button button-primary" disabled={disabled}>Modul anlegen <Arrow/></button></form></details>;
}

function ModuleEditor({ item, disabled, canEdit, canApprove, mutate, onContentReadError, onContentRefreshed }: { item: Module; disabled: boolean; canEdit: boolean; canApprove: boolean; mutate: Mutate; onContentReadError: (error: unknown) => void; onContentRefreshed: (chapterId: string) => void }) {
  const prefix = `module-${item.id}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await mutate(`/admin/course-modules/${item.id}`, 'PATCH', { revision: item.revision, title: textValue(form, 'title'),
      description: textValue(form, 'description'), position: Number(form.get('position')) }, 'Modul gespeichert.');
  }
  async function remove() {
    if (!window.confirm(`Leeres Modul „${item.title}“ wirklich löschen?`)) return;
    await mutate(`/admin/course-modules/${item.id}`, 'DELETE', { revision: item.revision }, 'Modul gelöscht.');
  }
  return <article className="module-item"><div className="module-header"><span className="position-mark">{String(item.position).padStart(2, '0')}</span>
    <div><h3>{item.title}</h3><p>{item.chapters.length} Kapitel</p></div></div>
    {item.description && <p className="module-description">{item.description}</p>}
    {canEdit && <details className="editor-details"><summary>Modul bearbeiten</summary><form key={`${item.id}:${item.revision}`} className="stack-form editor-form" onSubmit={submit}>
      <Field label="Modultitel" id={`${prefix}-title`}><input id={`${prefix}-title`} name="title" defaultValue={item.title} maxLength={160} required/></Field>
      <Field label="Beschreibung (optional)" id={`${prefix}-description`}><textarea id={`${prefix}-description`} name="description" defaultValue={item.description || ''} maxLength={4000} rows={3}/></Field>
      <Field label="Position" id={`${prefix}-position`}><input id={`${prefix}-position`} name="position" type="number" min="0" max="100000" defaultValue={item.position} required/></Field>
      <div className="editor-actions"><button className="button button-secondary" disabled={disabled}>Modul speichern</button>
        <button type="button" className="danger-link" disabled={disabled || item.chapters.length > 0} onClick={() => void remove()}>Modul löschen</button></div>
      {item.chapters.length > 0 && <p className="muted editor-hint">Zum Löschen zuerst alle Kapitel entfernen.</p>}</form></details>}
    <div className="chapter-list">{item.chapters.map(chapter => <ChapterEditor key={chapter.id} chapter={chapter} disabled={disabled} canEdit={canEdit} canApprove={canApprove} mutate={mutate} onContentReadError={onContentReadError} onContentRefreshed={onContentRefreshed}/>)}</div>
    {canEdit && <AddChapter item={item} disabled={disabled} mutate={mutate}/>}
  </article>;
}

function ChapterEditor({ chapter, disabled, canEdit, canApprove, mutate, onContentReadError, onContentRefreshed }: { chapter: Chapter; disabled: boolean; canEdit: boolean; canApprove: boolean; mutate: Mutate; onContentReadError: (error: unknown) => void; onContentRefreshed: (chapterId: string) => void }) {
  const prefix = `chapter-${chapter.id}`;
  const [contentCount, setContentCount] = useState(chapter._count.contents);
  useEffect(() => { setContentCount(chapter._count.contents); }, [chapter._count.contents]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await mutate(`/admin/course-chapters/${chapter.id}`, 'PATCH', { revision: chapter.revision, title: textValue(form, 'title'),
      summary: textValue(form, 'summary'), estimated_minutes: optionalNumber(form, 'minutes'), position: Number(form.get('position')) }, 'Kapitel gespeichert.');
  }
  async function remove() {
    if (!window.confirm(`Kapitel „${chapter.title}“ wirklich löschen?`)) return;
    await mutate(`/admin/course-chapters/${chapter.id}`, 'DELETE', { revision: chapter.revision }, 'Kapitel gelöscht.');
  }
  return <div className="chapter-item"><div className="chapter-heading"><span>{String(chapter.position).padStart(2, '0')}</span><strong>{chapter.title}</strong>
    {chapter.estimated_minutes !== null && <small>{chapter.estimated_minutes} Min.</small>}</div>
    {chapter.summary && <p className="module-description">{chapter.summary}</p>}
    {canEdit && <details className="editor-details"><summary>Kapitel bearbeiten</summary><form key={`${chapter.id}:${chapter.revision}`} className="stack-form editor-form" onSubmit={submit}>
      <Field label="Kapiteltitel" id={`${prefix}-title`}><input id={`${prefix}-title`} name="title" defaultValue={chapter.title} maxLength={160} required/></Field>
      <Field label="Zusammenfassung (optional)" id={`${prefix}-summary`}><textarea id={`${prefix}-summary`} name="summary" defaultValue={chapter.summary || ''} rows={3} maxLength={4000}/></Field>
      <div className="field-row"><Field label="Position" id={`${prefix}-position`}><input id={`${prefix}-position`} name="position" type="number" min="0" max="100000" defaultValue={chapter.position} required/></Field>
        <Field label="Dauer in Minuten (optional)" id={`${prefix}-minutes`}><input id={`${prefix}-minutes`} name="minutes" type="number" min="1" max="100000" defaultValue={chapter.estimated_minutes ?? ''}/></Field></div>
      <div className="editor-actions"><button className="button button-secondary" disabled={disabled}>Kapitel speichern</button>
        <button type="button" className="danger-link" disabled={disabled || contentCount > 0} onClick={() => void remove()}>Kapitel löschen</button></div>
      {contentCount > 0 && <p className="muted editor-hint">Zum Löschen zuerst alle Inhaltsbausteine entfernen.</p>}</form></details>}
    {canEdit && <ChapterExams chapterId={chapter.id} disabled={disabled} canApprove={canApprove} onAccessLost={onContentReadError}/>}
    <ChapterContents chapterId={chapter.id} count={contentCount} disabled={disabled} canEdit={canEdit} mutate={mutate} onAccessLost={onContentReadError} onRefreshed={() => onContentRefreshed(chapter.id)} onCount={setContentCount}/>
  </div>;
}

function AddChapter({ item, disabled, mutate }: { item: Module; disabled: boolean; mutate: Mutate }) {
  const prefix = `new-chapter-${item.id}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget, form = new FormData(element);
    if ((await mutate(`/admin/course-modules/${item.id}/chapters`, 'POST', { title: textValue(form, 'title'),
      summary: textValue(form, 'summary'), estimated_minutes: optionalNumber(form, 'minutes'), position: Number(form.get('position')) }, 'Kapitel angelegt.')).ok) element.reset();
  }
  return <details className="editor-details add-details"><summary>+ Kapitel hinzufügen</summary><form className="stack-form editor-form" onSubmit={submit}>
    <Field label="Kapiteltitel" id={`${prefix}-title`}><input id={`${prefix}-title`} name="title" maxLength={160} required/></Field>
    <Field label="Zusammenfassung (optional)" id={`${prefix}-summary`}><textarea id={`${prefix}-summary`} name="summary" rows={3} maxLength={4000}/></Field>
    <div className="field-row"><Field label="Position" id={`${prefix}-position`}><input id={`${prefix}-position`} name="position" type="number" min="0" max="100000" defaultValue={nextPosition(item.chapters)} required/></Field>
      <Field label="Dauer in Minuten (optional)" id={`${prefix}-minutes`}><input id={`${prefix}-minutes`} name="minutes" type="number" min="1" max="100000"/></Field></div>
    <button className="button button-secondary" disabled={disabled}>Kapitel anlegen <Arrow/></button></form></details>;
}

function Staff({ course, canReadUsers, disabled, mutate }: { course: CourseDetail; canReadUsers: boolean; disabled: boolean; mutate: Mutate }) {
  const [users, setUsers] = useState<User[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [role, setRole] = useState('manager'), [userId, setUserId] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  async function load(next?: string) {
    setLoading(true); setError('');
    try { const page = await api<Page<User>>(`/admin/users?limit=100${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      setUsers(current => next ? [...current, ...page.data] : page.data); setCursor(page.next_cursor); }
    catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }
  useEffect(() => { if (canReadUsers) void load(); }, [canReadUsers]);
  const neededRole = role === 'manager' ? 'course_manager' : 'instructor';
  const eligible = users.filter(user => user.status === 'active' && user.roles.includes(neededRole));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((await mutate(`/admin/courses/${course.id}/staff`, 'PUT', { user_id: userId, scope_role: role }, 'Kurszuordnung gespeichert.')).ok) setUserId('');
  }
  async function remove(userIdToRemove: string, scope: string) {
    if (!window.confirm('Diese Kurszuordnung wirklich entfernen?')) return;
    await mutate(`/admin/courses/${course.id}/staff/${userIdToRemove}/${scope}`, 'DELETE', undefined, 'Kurszuordnung entfernt.');
  }
  return <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">ZUGRIFF</span><h2>Kurszuordnungen</h2>
    <p>Nur zugewiesene Kursmanager und Dozenten können diesen Entwurf bearbeiten. Änderungen erfordern eine frische Identitätsbestätigung.</p></div></div>
    <div className="staff-list">{course.staff?.length ? course.staff.map(item => {
      const user = users.find(candidate => candidate.id === item.user_id);
      return <div className="staff-row" key={`${item.user_id}:${item.scope_role}`}><div><strong>{user ? `${user.first_name} ${user.last_name}` : item.user_id}</strong>
        <span>{item.scope_role === 'manager' ? 'Kursmanager' : 'Dozent'}{user ? ` · ${user.email}` : ''}</span></div>
        <button type="button" className="danger-link" disabled={disabled} onClick={() => void remove(item.user_id, item.scope_role)}>Entfernen</button></div>;
    }) : <p className="muted">Noch keine Kurszuordnungen vorhanden.</p>}</div>
    <details className="editor-details"><summary>Identität für geschützte Aktionen bestätigen</summary><div className="editor-form"><Reauth mfa/></div></details>
    <div className="inner-divider"/><h3>Person zuordnen</h3><p className="muted">Die Person muss aktiv sein und die entsprechende Rolle bereits besitzen. Bei einem Rollenentzug wird die zugehörige Kurszuordnung entfernt.</p>
    <Notice message={error}/><form className="stack-form" onSubmit={submit}>
      <Field label="Rolle im Kurs" id="staff-role"><select id="staff-role" value={role} onChange={e => { setRole(e.target.value); setUserId(''); }}><option value="manager">Kursmanager</option><option value="instructor">Dozent</option></select></Field>
      {canReadUsers && <Field label="Aktives Konto auswählen" id="staff-user-select"><select id="staff-user-select" value={eligible.some(user => user.id === userId) ? userId : ''} onChange={e => setUserId(e.target.value)}>
        <option value="">{loading ? 'Konten werden geladen …' : 'Konto auswählen oder ID eingeben'}</option>{eligible.map(user => <option value={user.id} key={user.id}>{user.first_name} {user.last_name} · {user.email}</option>)}</select></Field>}
      {cursor && <button type="button" className="inline-button load-users" disabled={loading || disabled} onClick={() => void load(cursor)}>Weitere Konten laden</button>}
      <Field label="Benutzer-ID" id="staff-user-id" hint="Bei Bedarf die UUID eines passenden aktiven Kontos eingeben."><input id="staff-user-id" value={userId} onChange={e => setUserId(e.target.value)} maxLength={36} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}" aria-describedby="staff-user-id-hint" required/></Field>
      <button className="button button-primary" disabled={disabled}>Person zuordnen <Arrow/></button></form>
    {canReadUsers && <p className="muted editor-hint">Rollen lassen sich in der <Link className="text-link" href="/admin">Nutzerverwaltung</Link> vergeben.</p>}
  </section>;
}
