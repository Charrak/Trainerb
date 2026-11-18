const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const Redis = require('ioredis');
const OTPAuth = require('otpauth');
const { uuidv7 } = require('uuidv7');
const { createApplication } = require('../../apps/api/dist/application');
const { Database } = require('../../apps/api/dist/database');
const { Sessions } = require('../../apps/api/dist/sessions');
const { Catalog } = require('../../apps/api/dist/catalog');
const { seedCatalog } = require('../../apps/api/dist/cli/catalog');
const { unseal } = require('../../apps/api/dist/security');

const origin = 'https://academy.test';
const password = 'Kranich!Sonne2026';
let app, db, server, redis, admin, adminUser, manager, instructor, support, participant, managerUser, instructorUser, courseA, courseB;
let adminRecovery, managerRecovery, supportRecovery, contentFixture, releaseAdmin, releaseAdminUser, releaseRecovery;
// Current TOTP for re-authentication: reusing the same step inside an already
// verified session is allowed, so tests need no unlimited recovery codes.
async function currentTotp(userId) {
  const { unseal } = require('../../apps/api/dist/security');
  const factor = await db.userMfaFactor.findFirstOrThrow({ where: { user_id: userId, type: 'totp', status: 'active' } });
  const { secret } = unseal(factor.secret_ciphertext, `mfa:${factor.id}`, factor.key_id);
  // The server derives the TOTP label from the account e-mail (`issuer:label`).
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

class Browser {
  constructor() { this.cookies = new Map(); }
  collect(response) {
    for (const line of response.headers['set-cookie'] || []) {
      const pair = line.split(';', 1)[0], at = pair.indexOf('=');
      const name = pair.slice(0, at), value = pair.slice(at + 1);
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  cookie() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  async get(path) {
    const r = request(server).get(`/api/v1${path}`);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    return this.collect(await r);
  }
  async change(method, path, body, options = {}) {
    let csrf;
    if (!options.noCsrf) {
      const response = await this.get('/auth/csrf'); status(response, 200); csrf = response.body.csrf_token;
    }
    const r = request(server)[method](`/api/v1${path}`).set('Origin', options.origin || origin);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    if (csrf) r.set('X-CSRF-Token', csrf);
    if (body !== undefined) r.send(body);
    return this.collect(await r);
  }
}
function status(response, expected) { assert.equal(response.status, expected, JSON.stringify(response.body)); }
async function activate(user) {
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { user_id: user.id, template_version: { template: { key: 'activation' } } } });
  const { token } = unseal(mail.variables_secret_ciphertext, `outbox:${mail.id}`, mail.secret_key_id);
  status(await new Browser().change('post', '/auth/activate', { token, password }), 204);
}
async function register(name) {
  const email = `${name}@example.invalid`, browser = new Browser();
  status(await browser.change('post', '/auth/register', { email, first_name: 'Test', last_name: name }), 202);
  const user = await db.user.findUniqueOrThrow({ where: { email_canonical: email } });
  await activate(user);
  return { user, email, browser };
}
async function login(browser, email) { return browser.change('post', '/auth/login', { email, password }); }
async function enroll(browser, email) {
  const logged = await login(browser, email); status(logged, 202); assert.equal(logged.body.status, 'mfa_enrollment_required');
  status(await browser.get('/admin/courses'), 403); // preauth is not a backoffice session
  const setup = await browser.change('post', '/auth/mfa/enrollment/start', {}); status(setup, 200);
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const confirmed = await browser.change('post', '/auth/mfa/enrollment/confirm', { code: totp.generate() }); status(confirmed, 200);
  return confirmed.body.recovery_codes;
}
async function grant(userId, roleKeys) {
  const response = await admin.change('put', `/admin/users/${userId}/roles`, { role_keys: roleKeys, reason_code: 'staff_change' });
  status(response, 200);
}
async function createCourse(slug, extra = {}) {
  const response = await admin.change('post', '/admin/courses', { slug, title: `Entwurf ${slug}`, ...extra });
  status(response, 201); return response.body;
}
async function assign(courseId, userId, scope) {
  return admin.change('put', `/admin/courses/${courseId}/staff`, { user_id: userId, scope_role: scope });
}
async function contextFor(browser) {
  const ctx = await app.get(Sessions).read({ cookies: Object.fromEntries(browser.cookies) });
  assert.ok(ctx); return ctx;
}
const rejectedStatus = expected => error => error.getStatus?.() === expected;

before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
  app = await createApplication(); await app.listen(0, '127.0.0.1'); server = app.getHttpServer(); db = app.get(Database);
  await db.$executeRawUnsafe('TRUNCATE TABLE courses, users, roles, permissions, email_templates, email_template_versions, email_outbox, automation_jobs, automation_job_attempts RESTART IDENTITY CASCADE');
  await seedCatalog(db);
  redis = new Redis(process.env.REDIS_URL);
  const keys = await redis.keys('trainerb:rl:*'); if (keys.length) await redis.del(...keys);
  execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...process.env,
    BOOTSTRAP_ADMIN_EMAIL: 'catalog-admin@example.invalid', BOOTSTRAP_ADMIN_FIRST_NAME: 'Test', BOOTSTRAP_ADMIN_LAST_NAME: 'Admin' }, stdio: 'pipe' });
  adminUser = await db.user.findUniqueOrThrow({ where: { email_canonical: 'catalog-admin@example.invalid' } });
  await activate(adminUser); admin = new Browser(); adminRecovery = await enroll(admin, adminUser.email_canonical);
  const managerFixture = await register('catalog-manager'); managerUser = managerFixture.user; manager = managerFixture.browser;
  const instructorFixture = await register('catalog-instructor'); instructorUser = instructorFixture.user; instructor = instructorFixture.browser;
  const supportFixture = await register('catalog-support'); support = supportFixture.browser;
  const participantFixture = await register('catalog-participant'); participant = participantFixture.browser;
  await grant(managerUser.id, ['participant', 'course_manager']);
  await grant(instructorUser.id, ['participant', 'instructor']);
  await grant(supportFixture.user.id, ['participant', 'support']);
  managerRecovery = await enroll(manager, managerFixture.email);
  await enroll(instructor, instructorFixture.email);
  supportRecovery = await enroll(support, supportFixture.email);
  status(await login(participant, participantFixture.email), 200);
  // A second global administrator with unused recovery codes: release tests
  // need several independent fresh second-factor confirmations.
  const releaseFixture = await register('catalog-release-admin');
  releaseAdminUser = releaseFixture.user; releaseAdmin = releaseFixture.browser;
  await grant(releaseAdminUser.id, ['participant', 'superadmin']);
  releaseRecovery = await enroll(releaseAdmin, releaseFixture.email);
  courseA = await createCourse('entwurf-a', { visibility: 'public', expected_module_count: 14, expected_chapter_count: 42,
    expected_exams_per_chapter: 2, chapter_completion_mode: 'all_chapter_exams' });
  courseB = await createCourse('entwurf-b');
});
after(async () => { if (redis) redis.disconnect(); if (app) await app.close(); });

test('drafts remain private; public routes and backoffice require correct permissions, MFA and CSRF', async () => {
  const anonymous = new Browser();
  const catalog = await anonymous.get('/courses'); status(catalog, 200); assert.deepEqual(catalog.body, { data: [], next_cursor: null });
  status(await anonymous.get('/courses/entwurf-a'), 404); // even a draft with intended visibility public is not published
  status(await anonymous.get('/courses/not-a-valid%20slug'), 404);
  status(await anonymous.get('/courses?limit=101'), 422);
  status(await anonymous.get('/admin/courses'), 401);
  status(await participant.get('/admin/courses'), 403);
  status(await support.get('/admin/courses'), 403);
  const managerPage = await manager.get('/admin/courses'); status(managerPage, 200); assert.deepEqual(managerPage.body.data, []);
  status(await manager.get(`/admin/courses/${courseA.id}`), 404);
  status(await admin.change('post', '/admin/courses', { slug: 'no-csrf', title: 'Test' }, { noCsrf: true }), 403);
  status(await admin.change('post', '/admin/courses', { slug: 'wrong-origin', title: 'Test' }, { origin: 'https://attacker.invalid' }), 403);
  status(await manager.change('post', '/admin/courses', { slug: 'no-create', title: 'Test' }), 403);
  status(await admin.get('/admin/courses?limit=101'), 422);
  // Commerce exists, but the catalogue of sellable products stays empty while
  // the operator has not enabled sales.
  assert.equal((await admin.get('/health')).body.commerce_enabled, true);
  assert.equal((await admin.get('/health')).body.publication_enabled, true);
  assert.equal((await admin.get('/health')).body.exams_enabled, false);
  assert.equal((await new Browser().get('/shop/products')).body.sales_enabled, false);
  status(await new Browser().get('/cart'), 401);
});

test('strict validation, unique positions and simultaneous creation preserve invariants and audit', async () => {
  const beforeCount = await db.course.count(), beforeAudit = await db.auditEvent.count({ where: { action: 'course.created' } });
  for (const body of [
    { slug: 'Invalid slug', title: 'Test' }, { slug: 'valid-x', title: '\u200b' },
    { slug: 'valid-x', title: 'Test', expected_module_count: 501 }, { slug: 'valid-x', title: 'Test', expected_chapter_count: 5001 },
    { slug: 'valid-x', title: 'Test', expected_exams_per_chapter: 0 }, { slug: 'valid-x', title: 'A\u0000B' },
    { slug: 'valid-x', title: 'Test', chapter_completion_mode: 'invented' },
  ]) status(await admin.change('post', '/admin/courses', body), 422);
  status(await admin.change('post', '/admin/courses', { slug: 'valid-x', title: 'Test', status: 'published' }), 400);
  assert.equal(await db.course.count(), beforeCount);
  assert.equal(await db.auditEvent.count({ where: { action: 'course.created' } }), beforeAudit);
  const [a, b] = await Promise.all([
    admin.change('post', '/admin/courses', { slug: 'parallel', title: 'Eins' }),
    admin.change('post', '/admin/courses', { slug: 'parallel', title: 'Zwei' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const created = a.status === 201 ? a.body : b.body;
  const [m1, m2] = await Promise.all([
    admin.change('post', `/admin/course-versions/${created.version_id}/modules`, { title: 'Modul 1', position: 1 }),
    admin.change('post', `/admin/course-versions/${created.version_id}/modules`, { title: 'Modul 2', position: 1 }),
  ]);
  assert.deepEqual([m1.status, m2.status].sort(), [201, 409]);
  assert.equal(await db.courseModule.count({ where: { course_version_id: created.version_id } }), 1);
  assert.equal(await db.auditEvent.count({ where: { target_ref: created.id, action: 'course.module_created' } }), 1);
  status(await admin.get('/admin/courses?limit=1&cursor=00000000-0000-7000-8000-000000000000'), 404);
  const first = await admin.get('/admin/courses?limit=1'); status(first, 200); assert.equal(first.body.data.length, 1); assert.ok(first.body.next_cursor);
  const second = await admin.get(`/admin/courses?limit=1&cursor=${first.body.next_cursor}`); status(second, 200);
  assert.notEqual(first.body.data[0].id, second.body.data[0].id);
});

test('module and chapter edits use revisions; deletion is guarded and audited', async () => {
  const c = await createCourse('edit-test');
  const makeModule = await admin.change('post', `/admin/course-versions/${c.version_id}/modules`, { title: 'Start', position: 1 }); status(makeModule, 201);
  const module = makeModule.body;
  const makeChapter = await admin.change('post', `/admin/course-modules/${module.id}/chapters`, { title: 'Kapitel', summary: 'Test', position: 1, estimated_minutes: 15 }); status(makeChapter, 201);
  const chapter = makeChapter.body;
  status(await admin.change('post', `/admin/course-modules/${module.id}/chapters`, { title: 'Doppelt', position: 1 }), 409);
  status(await admin.change('patch', `/admin/course-versions/${c.version_id}`, { title: 'Ohne Revision' }), 422);
  const [v1, v2] = await Promise.all([
    admin.change('patch', `/admin/course-versions/${c.version_id}`, { revision: 1, title: 'Erste Änderung' }),
    admin.change('patch', `/admin/course-versions/${c.version_id}`, { revision: 1, title: 'Zweite Änderung' }),
  ]);
  assert.deepEqual([v1.status, v2.status].sort(), [200, 409]);
  assert.equal((await db.courseVersion.findUniqueOrThrow({ where: { id: c.version_id } })).revision, 2);
  const [m1, m2] = await Promise.all([
    admin.change('patch', `/admin/course-modules/${module.id}`, { revision: 1, title: 'Neu A' }),
    admin.change('patch', `/admin/course-modules/${module.id}`, { revision: 1, title: 'Neu B' }),
  ]);
  assert.deepEqual([m1.status, m2.status].sort(), [200, 409]);
  const ch = await admin.change('patch', `/admin/course-chapters/${chapter.id}`, { revision: 1, title: 'Aktualisiert', estimated_minutes: 20 });
  status(ch, 200); assert.equal(ch.body.revision, 2);
  const staleChapter = await admin.change('delete', `/admin/course-chapters/${chapter.id}`, { revision: 1 });
  status(staleChapter, 409); assert.equal(staleChapter.body.code, 'STALE_DRAFT');
  const nonempty = await admin.change('delete', `/admin/course-modules/${module.id}`, { revision: 2 });
  status(nonempty, 409); assert.equal(nonempty.body.code, 'MODULE_NOT_EMPTY');
  status(await admin.change('delete', `/admin/course-chapters/${chapter.id}`, { revision: 2 }), 204);
  status(await admin.change('delete', `/admin/course-modules/${module.id}`, { revision: 2 }), 204);
  for (const action of ['course.draft_updated', 'course.module_updated', 'course.chapter_updated', 'course.chapter_deleted', 'course.module_deleted']) {
    assert.equal(await db.auditEvent.count({ where: { target_ref: c.id, action } }), 1, action);
  }
});

test('assignments scope read and write; fresh MFA and current membership are enforced', async () => {
  const invalid = await assign(courseA.id, managerUser.id, 'instructor'); status(invalid, 422);
  status(await assign(courseA.id, managerUser.id, 'manager'), 200);
  status(await assign(courseA.id, managerUser.id, 'manager'), 200); // idempotent, no duplicate audit
  status(await assign(courseB.id, instructorUser.id, 'instructor'), 200);
  assert.equal(await db.auditEvent.count({ where: { target_ref: courseA.id, action: 'course.staff_assigned' } }), 1);
  const managerList = await manager.get('/admin/courses'); status(managerList, 200);
  assert.deepEqual(managerList.body.data.map(item => item.id), [courseA.id]);
  const detail = await manager.get(`/admin/courses/${courseA.id}`); status(detail, 200); assert.equal(Object.hasOwn(detail.body, 'staff'), false);
  status(await manager.get(`/admin/courses/${courseB.id}`), 404);
  status(await manager.get(`/admin/courses?cursor=${courseB.id}`), 404);
  status(await instructor.get(`/admin/courses/${courseA.id}`), 404);
  status(await instructor.get(`/admin/courses/${courseB.id}`), 200);
  status(await manager.change('post', `/admin/course-versions/${courseB.version_id}/modules`, { title: 'Fremd', position: 5 }), 404);
  status(await manager.change('put', `/admin/courses/${courseA.id}/staff`, { user_id: instructorUser.id, scope_role: 'instructor' }), 403);
  status(await manager.change('post', `/admin/course-versions/${courseA.version_id}/modules`, { title: 'Zugewiesen', position: 8 }), 201);
  // Different users lock the same course, not merely their own user rows.
  const initialRevision = detail.body.versions[0].revision;
  const [editAdmin, editManager] = await Promise.all([
    admin.change('patch', `/admin/course-versions/${courseA.version_id}`, { revision: initialRevision, title: 'Admin-Version' }),
    manager.change('patch', `/admin/course-versions/${courseA.version_id}`, { revision: initialRevision, title: 'Manager-Version' }),
  ]);
  assert.deepEqual([editAdmin.status, editManager.status].sort(), [200, 409]);
  const [moduleAdmin, moduleManager] = await Promise.all([
    admin.change('post', `/admin/course-versions/${courseA.version_id}/modules`, { title: 'Admin-Modul', position: 40 }),
    manager.change('post', `/admin/course-versions/${courseA.version_id}/modules`, { title: 'Manager-Modul', position: 40 }),
  ]);
  assert.deepEqual([moduleAdmin.status, moduleManager.status].sort(), [201, 409]);
  const staleCtx = await contextFor(manager);
  const session = await db.authSession.findFirstOrThrow({ where: { user_id: adminUser.id, kind: 'backoffice', revoked_at: null } });
  await db.authSession.update({ where: { id: session.id }, data: { reauthenticated_at: new Date(Date.now() - 6 * 60_000) } });
  const tooOld = await admin.change('delete', `/admin/courses/${courseA.id}/staff/${managerUser.id}/manager`);
  status(tooOld, 403); assert.equal(tooOld.body.code, 'REAUTH_REQUIRED');
  status(await admin.change('post', '/auth/reauth', { password, recovery_code: adminRecovery[0] }), 204);
  status(await admin.change('delete', `/admin/courses/${courseA.id}/staff/${managerUser.id}/manager`), 204);
  status(await manager.get(`/admin/courses/${courseA.id}`), 404);
  await assert.rejects(app.get(Catalog).detail(staleCtx, courseA.id), rejectedStatus(404));
  await assert.rejects(app.get(Catalog).addModule(staleCtx, courseA.version_id, { title: 'Nach Entzug', position: 20 }), rejectedStatus(404));
  assert.equal(await db.auditEvent.count({ where: { target_ref: courseA.id, action: 'course.staff_removed' } }), 1);
});

test('a concurrent unassignment and edit serialize on the course and leave no subsequent access', async () => {
  status(await assign(courseA.id, managerUser.id, 'manager'), 200);
  const [removed, edited] = await Promise.all([
    admin.change('delete', `/admin/courses/${courseA.id}/staff/${managerUser.id}/manager`),
    manager.change('post', `/admin/course-versions/${courseA.version_id}/modules`, { title: 'Parallel zum Entzug', position: 50 }),
  ]);
  status(removed, 204); assert.ok([201, 404].includes(edited.status), JSON.stringify(edited.body));
  assert.equal(await db.courseStaff.count({ where: { course_id: courseA.id, user_id: managerUser.id } }), 0);
  status(await manager.change('post', `/admin/course-versions/${courseA.version_id}/modules`, { title: 'Nach Entzug', position: 51 }), 404);
});

test('global access cannot be obtained by combining an unrelated admin role with a scoped permission', async () => {
  const fixture = await register('mixed-role');
  await grant(fixture.user.id, ['participant', 'admin', 'instructor']);
  await enroll(fixture.browser, fixture.email);
  status(await assign(courseA.id, fixture.user.id, 'instructor'), 200);
  const role = await db.role.findUniqueOrThrow({ where: { key: 'admin' } });
  const perms = await db.permission.findMany({ where: { key: { in: ['courses.read', 'courses.edit'] } } });
  assert.equal(perms.length, 2);
  try {
    await db.rolePermission.deleteMany({ where: { role_id: role.id, permission_id: { in: perms.map(item => item.id) } } });
    const list = await fixture.browser.get('/admin/courses'); status(list, 200); assert.deepEqual(list.body.data.map(item => item.id), [courseA.id]);
    const detail = await fixture.browser.get(`/admin/courses/${courseA.id}`); status(detail, 200); assert.equal(Object.hasOwn(detail.body, 'staff'), false);
    status(await fixture.browser.get(`/admin/courses/${courseB.id}`), 404);
    status(await fixture.browser.change('post', `/admin/course-versions/${courseB.version_id}/modules`, { title: 'Nicht global', position: 4 }), 404);
    status(await fixture.browser.change('post', `/admin/course-versions/${courseA.version_id}/modules`, { title: 'Zugewiesen', position: 9 }), 201);
  } finally {
    await db.rolePermission.createMany({ data: perms.map(permission => ({ role_id: role.id, permission_id: permission.id })), skipDuplicates: true });
  }
});

test('lesson blocks are scoped, validated, paginated and never returned in the public catalog', async () => {
  const course = await createCourse('lesson-content', { visibility: 'public' });
  const moduleResponse = await admin.change('post', `/admin/course-versions/${course.version_id}/modules`, { title: 'Modul', position: 1 });
  status(moduleResponse, 201);
  const module = moduleResponse.body;
  const chapterResponse = await admin.change('post', `/admin/course-modules/${module.id}/chapters`, { title: 'Kapitel', position: 1 });
  status(chapterResponse, 201);
  const chapter = chapterResponse.body, base = `/admin/course-chapters/${chapter.id}/contents`;
  status(await new Browser().get(base), 401);
  status(await participant.get(base), 403);
  status(await support.get(base), 403);
  status(await instructor.get(base), 404);
  status(await manager.get(base), 404);
  status(await manager.change('post', base, { block: { kind: 'paragraph', text: 'Kein Zugriff' } }), 404);
  status(await assign(course.id, managerUser.id, 'manager'), 200);
  status(await manager.change('post', base, { block: { kind: 'paragraph', text: 'Kein CSRF' } }, { noCsrf: true }), 403);
  status(await manager.change('post', base, { block: { kind: 'paragraph', text: 'Falsche Origin' } }, { origin: 'https://attacker.invalid' }), 403);
  const inputs = [
    { title: 'Interne Notiz', block: { kind: 'paragraph', text: '  Nur Test <script>alert(1)</script>\nZweite Zeile.  ' } },
    { position: 5, block: { kind: 'heading', text: 'Überschrift', level: 2 } },
    { block: { kind: 'list', items: ['Erster Punkt', 'Zweiter Punkt'] } },
    { block: { kind: 'link', text: 'Extern', href: 'https://example.org/pfad' } },
    { block: { kind: 'link', text: 'Intern', href: '/kurse?typ=test#liste' } },
  ];
  const created = [];
  for (const input of inputs) {
    const result = await manager.change('post', base, input); status(result, 201); created.push(result.body);
    assert.equal(result.body.body.blocks[0].id, result.body.id);
  }
  assert.deepEqual(created.map(item => item.position), [1, 5, 6, 7, 8]);
  assert.equal(created[0].body.blocks[0].text, 'Nur Test <script>alert(1)</script>\nZweite Zeile.');
  assert.equal(created[4].body.blocks[0].href, '/kurse?typ=test#liste');
  status(await manager.change('post', base, { position: 5, block: { kind: 'paragraph', text: 'Doppelte Position' } }), 409);
  const invalid = [
    { kind: 'paragraph', text: '' }, { kind: 'paragraph', text: '\u200b' }, { kind: 'paragraph', text: 'A\0B' },
    { kind: 'paragraph', text: 'A'.repeat(7001) }, { kind: 'heading', text: 'Kopf', level: 1 },
    { kind: 'heading', text: 'Kopf', level: 5 }, { kind: 'list', items: [] },
    { kind: 'list', items: Array(31).fill('Punkt') }, { kind: 'list', items: ['A\nB'] },
    ...['http://example.org', 'javascript:alert(1)', '//evil.invalid', '/\\evil.invalid',
      'https://user@evil.invalid', 'https://example.org/has space', 'data:text/html,test'].map(href => ({ kind: 'link', text: 'Link', href })),
    { kind: 'video', text: 'Nicht unterstützt' },
  ];
  for (const block of invalid) status(await admin.change('post', base, { block }), 422);
  status(await admin.change('post', base, { block: { kind: 'paragraph', text: 'Test', href: 'https://example.org' } }), 400);
  status(await admin.change('post', base, { block: { kind: 'paragraph', text: 'Test' }, media_asset_id: randomUUID() }), 400);
  assert.equal(await db.chapterContent.count({ where: { chapter_id: chapter.id } }), 5);
  const page1 = await manager.get(`${base}?limit=2`); status(page1, 200);
  assert.equal(page1.body.total, 5);
  assert.deepEqual(page1.body.data.map(item => item.position), [1, 5]); assert.ok(page1.body.next_cursor);
  assert.ok(page1.body.data.every(item => item.editable));
  const page2 = await manager.get(`${base}?limit=2&cursor=${page1.body.next_cursor}`); status(page2, 200);
  assert.deepEqual(page2.body.data.map(item => item.position), [6, 7]); assert.ok(page2.body.next_cursor);
  const page3 = await manager.get(`${base}?limit=2&cursor=${page2.body.next_cursor}`); status(page3, 200);
  assert.deepEqual(page3.body.data.map(item => item.position), [8]); assert.equal(page3.body.next_cursor, null);
  status(await manager.get(`${base}?limit=51`), 422);
  const staleCursor = await manager.get(`${base}?cursor=${randomUUID()}`);
  status(staleCursor, 409); assert.equal(staleCursor.body.code, 'STALE_CURSOR');
  const detail = await manager.get(`/admin/courses/${course.id}`); status(detail, 200);
  assert.equal(detail.body.versions[0].modules[0].chapters[0]._count.contents, 5);
  assert.equal(JSON.stringify(detail.body).includes('Nur Test <script>'), false);
  status(await new Browser().get('/courses/lesson-content'), 404);
  const audit = await db.auditEvent.findMany({ where: { target_ref: course.id, action: 'course.content_created' } });
  assert.equal(audit.length, 5);
  assert.equal(JSON.stringify(audit).includes('example.org'), false);
  assert.equal(JSON.stringify(audit).includes('Nur Test'), false);
  contentFixture = { course, module, chapter, created };
});

test('lesson edits serialize, preserve unknown formats and prevent accidental chapter deletion', async () => {
  const { course, module, chapter, created } = contentFixture;
  const first = created[0], firstPath = `/admin/chapter-contents/${first.id}`;
  const [byAdmin, byManager] = await Promise.all([
    admin.change('patch', firstPath, { revision: 1, block: { kind: 'paragraph', text: 'Admin-Änderung' } }),
    manager.change('patch', firstPath, { revision: 1, block: { kind: 'paragraph', text: 'Manager-Änderung' } }),
  ]);
  assert.deepEqual([byAdmin.status, byManager.status].sort(), [200, 409]);
  assert.equal((await db.chapterContent.findUniqueOrThrow({ where: { id: first.id } })).revision, 2);
  const staleDelete = await admin.change('delete', firstPath, { revision: 1 });
  status(staleDelete, 409); assert.equal(staleDelete.body.code, 'STALE_DRAFT');
  const occupied = await admin.change('patch', `/admin/chapter-contents/${created[1].id}`, { revision: 1, position: 1 });
  status(occupied, 409);
  const nonempty = await admin.change('delete', `/admin/course-chapters/${chapter.id}`, { revision: 1 });
  status(nonempty, 409); assert.equal(nonempty.body.code, 'CHAPTER_NOT_EMPTY');
  assert.ok(await db.courseChapter.findUnique({ where: { id: chapter.id } }));

  // Text blocks must match their version and chapter. A future/unrecognized text
  // shape, if present, must remain read-only instead of being overwritten.
  const unknownId = randomUUID();
  const unknown = { id: unknownId, course_version_id: course.version_id, chapter_id: chapter.id, kind: 'text', position: 99,
    body: { schema_version: 1, blocks: [{ id: unknownId, kind: 'paragraph', text: 'Unbekannt', future_field: 'keep' }] } };
  await db.chapterContent.create({ data: unknown });
  const listed = await admin.get(`/admin/course-chapters/${chapter.id}/contents?limit=50`); status(listed, 200);
  assert.equal(listed.body.data.find(item => item.id === unknownId).editable, false);
  const unknownPatch = await admin.change('patch', `/admin/chapter-contents/${unknownId}`, { revision: 1, title: 'Nicht überschreiben' });
  status(unknownPatch, 409); assert.equal(unknownPatch.body.code, 'UNSUPPORTED_CONTENT');
  const unknownDelete = await admin.change('delete', `/admin/chapter-contents/${unknownId}`, { revision: 1 });
  status(unknownDelete, 409); assert.equal(unknownDelete.body.code, 'UNSUPPORTED_CONTENT');
  await db.chapterContent.delete({ where: { id: unknownId } }); // disposable fixture only
  const badId = randomUUID();
  const validBody = { schema_version: 1, blocks: [{ id: badId, kind: 'paragraph', text: 'Test' }] };
  await assert.rejects(db.chapterContent.create({ data: { id: badId, course_version_id: courseB.version_id,
    chapter_id: chapter.id, kind: 'text', position: 90, body: validBody } }));
  await assert.rejects(db.chapterContent.create({ data: { id: badId, course_version_id: course.version_id,
    chapter_id: chapter.id, kind: 'video', position: 90, body: validBody } }));
  await assert.rejects(db.chapterContent.create({ data: { id: badId, course_version_id: course.version_id,
    chapter_id: chapter.id, kind: 'text', position: 90, body: { schema_version: 1 } } }));
  await assert.rejects(db.chapterContent.create({ data: { id: badId, course_version_id: course.version_id,
    chapter_id: chapter.id, kind: 'text', position: 90, body: { schema_version: 1, blocks: [{ id: randomUUID(), kind: 'paragraph', text: 'Test' }] } } }));

  const [removed, concurrentEdit] = await Promise.all([
    admin.change('delete', `/admin/courses/${course.id}/staff/${managerUser.id}/manager`),
    manager.change('patch', firstPath, { revision: 2, block: { kind: 'paragraph', text: 'Parallel zum Entzug' } }),
  ]);
  status(removed, 204); assert.ok([200, 404].includes(concurrentEdit.status), JSON.stringify(concurrentEdit.body));
  status(await manager.get(`/admin/course-chapters/${chapter.id}/contents`), 404);
  status(await manager.change('patch', firstPath, { revision: 2, block: { kind: 'paragraph', text: 'Nach Entzug' } }), 404);
  for (const item of created) {
    const current = await db.chapterContent.findUniqueOrThrow({ where: { id: item.id } });
    status(await admin.change('delete', `/admin/chapter-contents/${item.id}`, { revision: current.revision }), 204);
  }
  status(await admin.change('delete', `/admin/course-chapters/${chapter.id}`, { revision: 1 }), 204);
  status(await admin.change('delete', `/admin/course-modules/${module.id}`, { revision: 1 }), 204);
  assert.equal(await db.auditEvent.count({ where: { target_ref: course.id, action: 'course.content_deleted' } }), 5);
  const audit = await db.auditEvent.findMany({ where: { target_ref: course.id, action: { startsWith: 'course.content_' } } });
  assert.equal(JSON.stringify(audit).includes('Admin-Änderung'), false);
  assert.equal(JSON.stringify(audit).includes('Parallel zum Entzug'), false);
});

test('concurrent role revocation and assignment leave no stale grant; regrant requires a new course assignment', async () => {
  status(await assign(courseA.id, managerUser.id, 'manager'), 200);
  const staleCtx = await contextFor(manager);
  const [roleChange, assignment] = await Promise.all([
    admin.change('put', `/admin/users/${managerUser.id}/roles`, { role_keys: ['participant'], reason_code: 'staff_change' }),
    assign(courseB.id, managerUser.id, 'manager'),
  ]);
  status(roleChange, 200); assert.ok([200, 422].includes(assignment.status), JSON.stringify(assignment.body));
  assert.equal(await db.courseStaff.count({ where: { user_id: managerUser.id, scope_role: 'manager' } }), 0);
  assert.equal(await db.auditEvent.count({ where: { action: 'course.staff_roles_revoked', target_ref: managerUser.id } }), 1);
  const removedAudit = await db.auditEvent.findMany({ where: { action: 'course.staff_removed', target_ref: courseA.id } });
  assert.ok(removedAudit.some(event => event.after_safe?.user_id === managerUser.id && event.after_safe?.cause === 'role_revoked'));
  status(await manager.get('/admin/courses'), 401);
  await assert.rejects(app.get(Catalog).list(staleCtx), rejectedStatus(401));
  await assert.rejects(app.get(Catalog).addModule(staleCtx, courseA.version_id, { title: 'Veraltete Sitzung', position: 30 }), rejectedStatus(401));
  await grant(managerUser.id, ['participant', 'course_manager']);
  const again = new Browser(); const logged = await login(again, managerUser.email_canonical); status(logged, 202); assert.equal(logged.body.status, 'mfa_required');
  status(await again.change('post', '/auth/mfa/challenge', { recovery_code: managerRecovery[0] }), 200);
  const list = await again.get('/admin/courses'); status(list, 200); assert.deepEqual(list.body.data, []);
  status(await again.get(`/admin/courses/${courseA.id}`), 404);
});

test('database blocks malformed content and chapters linked to a different version', async () => {
  // A published course needs a published version, and a published version needs
  // publisher metadata; either half alone is rejected by the database.
  await assert.rejects(db.course.update({ where: { id: courseA.id }, data: { status: 'published' } }));
  await assert.rejects(db.courseVersion.update({ where: { id: courseA.version_id }, data: { state: 'published' } }));
  // The reverse direction also fails: a version alone leaves the course a draft,
  // and the guard trigger rejects a published course without a published version.
  await db.courseVersion.update({ where: { id: courseA.version_id }, data: { state: 'published',
    published_by: adminUser.id, published_at: new Date() } });
  await assert.rejects(db.course.update({ where: { id: courseB.id }, data: { status: 'published' } }));
  await db.courseVersion.update({ where: { id: courseA.version_id }, data: { state: 'draft', published_by: null, published_at: null } });

  await assert.rejects(db.courseVersion.update({ where: { id: courseA.version_id }, data: { description: { schema_version: 1 } } }));
  const module = await db.courseModule.findFirstOrThrow({ where: { course_version_id: courseA.version_id } });
  await assert.rejects(db.courseChapter.create({ data: { id: randomUUID(), course_version_id: courseB.version_id,
    module_id: module.id, title: 'Fremde Version', position: 99 } }));
  status(await new Browser().get('/courses/entwurf-a'), 404);
  status(await admin.change('post', `/admin/course-versions/${courseA.version_id}/publish`, {}), 404); // no per-version shortcut
  status(await admin.change('post', '/checkout', {}), 404);
});

test('public pagination and direct detail filter published, public courses independently (rolled-back fixtures)', async () => {
  // Publication is locked in the shipped database. This disposable test
  // transaction temporarily removes only those two checks, exercises the
  // future read filtering, and always rolls back both DDL and fixtures.
  const rollback = new Error('rollback test fixtures');
  try {
    await db.$transaction(async tx => {
      const rows = Array.from({ length: 105 }, (_, index) => ({ id: uuidv7(), slug: `released-${index}`, status: 'published', visibility: 'public', sort_order: index }));
      rows.push({ id: uuidv7(), slug: 'secret-private', status: 'published', visibility: 'private', sort_order: 0 });
      rows.push({ id: uuidv7(), slug: 'secret-unlisted', status: 'published', visibility: 'unlisted', sort_order: 0 });
      rows.push({ id: uuidv7(), slug: 'version-is-draft', status: 'published', visibility: 'public', sort_order: 0 });
      rows.push({ id: uuidv7(), slug: 'course-is-draft', status: 'draft', visibility: 'public', sort_order: 0 });
      await tx.course.createMany({ data: rows });
      await tx.courseVersion.createMany({ data: rows.map(row => ({ id: uuidv7(), course_id: row.id, version: 1,
        state: row.slug === 'version-is-draft' ? 'draft' : 'published', title: row.slug, created_by: adminUser.id,
        published_by: row.slug === 'version-is-draft' ? null : adminUser.id, published_at: row.slug === 'version-is-draft' ? null : new Date(),
        description: { schema_version: 1, blocks: [{ id: uuidv7(), kind: 'paragraph', text: 'Nur Text <script>test</script>' },
          { id: uuidv7(), kind: 'unknown', text: 'nicht anzeigen' }] } })) });
      const catalog = new Catalog(tx, app.get(Sessions));
      const first = await catalog.publicCourses(100, undefined); assert.equal(first.data.length, 100); assert.equal(first.next_cursor, 'released-99');
      assert.ok(first.data.every(item => !item.slug.startsWith('secret')));
      assert.equal(first.data[0].description, 'Nur Text <script>test</script>');
      const second = await catalog.publicCourses(100, first.next_cursor); assert.equal(second.data.length, 5); assert.equal(second.next_cursor, null);
      assert.equal((await catalog.publicCourse('released-104')).slug, 'released-104'); // not in first 100
      for (const slug of ['secret-private', 'secret-unlisted', 'version-is-draft', 'course-is-draft']) {
        await assert.rejects(catalog.publicCourse(slug), rejectedStatus(404));
      }
      await assert.rejects(catalog.publicCourses(25, 'secret-private'), rejectedStatus(404));
      throw rollback;
    }, { timeout: 30_000 });
    assert.fail('transaction should have been rolled back');
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(await db.course.count({ where: { slug: { startsWith: 'released-' } } }), 0);
  // Neither the removed draft locks nor any test fixture survived the rollback.
  const constraints = await db.$queryRaw`SELECT conname::text FROM pg_constraint WHERE conname IN ('phase2_course_publication_locked','phase2_version_publication_locked')`;
  assert.equal(constraints.length, 0);
  assert.equal(await db.courseVersion.count({ where: { state: 'published' } }), 0);
});

test('product and price drafts are admin-only, revocable and never publicly readable', async () => {
  const anonymous = new Browser(), base = '/admin/products';
  status(await anonymous.get(base), 401);
  status(await participant.get(base), 403);
  status(await support.get(base), 403);
  // Earlier tests revoked the manager session; a fresh login is required.
  const managerAgain = new Browser();
  status(await login(managerAgain, managerUser.email_canonical), 202);
  status(await managerAgain.change('post', '/auth/mfa/challenge', { recovery_code: managerRecovery[1] }), 200); // managerRecovery[0] was used earlier
  status(await managerAgain.get(base), 403); // course managers never reach the catalog-wide product scope
  const instructorAgain = new Browser();
  status(await login(instructorAgain, instructorUser.email_canonical), 202);
  status(await instructorAgain.get(base), 403); // preauth only, and never for instructors
  status(await admin.get('/products'), 404);
  status(await admin.get('/products/test-produkt'), 404);
  status(await admin.get('/prices'), 404);
  status(await admin.change('post', '/checkout', {}), 404);

  const created = await admin.change('post', base, { sku: 'FTB-SINGLE-01', type: 'single', title: '  Grundkurs Selbststudium  ',
    description: 'Synthetischer Produktentwurf.', courses: [{ course_id: courseA.id, access_days_override: 365 }] });
  status(created, 201);
  assert.equal(created.body.title, 'Grundkurs Selbststudium'); assert.equal(created.body.status, 'draft');
  assert.equal(created.body.courses, 1);
  const product = await admin.get(`${base}/${created.body.id}`); status(product, 200);
  assert.equal(product.body.prices.length, 0); assert.equal(product.body.courses[0].course_id, courseA.id);
  assert.equal(product.body.courses[0].access_days_override, 365);

  const duplicateSku = await admin.change('post', base, { sku: 'FTB-SINGLE-01', type: 'bundle', title: 'Doppelte SKU' });
  status(duplicateSku, 409); assert.equal(duplicateSku.body.code, 'PRODUCT_CONFLICT');
  for (const invalidInput of [
    { sku: 'ftb lower', type: 'single', title: 'Titel' },
    { sku: 'FTB-INVALID-01', type: 'subscription', title: 'Titel' },
    { sku: 'FTB-INVALID-02', type: 'single', title: '   ' },
    { sku: 'FTB-INVALID-03', type: 'single', title: 'Titel', courses: [{ course_id: courseA.id }, { course_id: courseB.id }] },
    { sku: 'FTB-INVALID-04', type: 'single', title: 'Titel', courses: [{ course_id: randomUUID() }] },
    { sku: 'FTB-INVALID-05', type: 'single', title: 'Titel', courses: [{ course_id: courseA.id }, { course_id: courseA.id }] },
    { sku: 'FTB-INVALID-06', type: 'single', title: 'Titel', status: 'active' },
  ]) status(await admin.change('post', base, invalidInput), invalidInput.status ? 400 : 422);
  assert.equal(await db.product.count(), 1);

  const priceBody = { currency: 'EUR', gross_cents: '19900', tax_category: 'standard', valid_from: '2027-01-01T09:30Z' };
  const price = await admin.change('post', `${base}/${created.body.id}/prices`, priceBody); status(price, 201);
  assert.equal(price.body.gross_cents, '19900'); assert.equal(price.body.status, 'draft'); assert.equal(price.body.currency, 'EUR');
  assert.equal(typeof price.body.gross_cents, 'string'); // never a JSON number
  for (const invalidPrice of [
    { ...priceBody, gross_cents: 19900 },
    { ...priceBody, gross_cents: '199.00' },
    { ...priceBody, gross_cents: '-100' },
    { ...priceBody, currency: 'USD' },
    { ...priceBody, valid_from: '2027-01-01T09:30:30Z' },
    { ...priceBody, valid_from: '2027-01-01' },
    { ...priceBody, valid_until: '2027-01-01T09:30Z' },
    { ...priceBody, sale_gross_cents: '14900' },
    { ...priceBody, sale_gross_cents: '20000', sale_starts_at: '2027-02-01T00:00Z', sale_ends_at: '2027-03-01T00:00Z' },
    { ...priceBody, tax_category: 'Standard 19%' },
    { ...priceBody, status: 'active' },
  ]) status(await admin.change('post', `${base}/${created.body.id}/prices`, invalidPrice), invalidPrice.status ? 400 : 422);
  const sale = await admin.change('post', `${base}/${created.body.id}/prices`, { ...priceBody, valid_from: '2028-01-01T00:00Z',
    sale_gross_cents: '14900', sale_starts_at: '2028-02-01T00:00Z', sale_ends_at: '2028-03-01T00:00Z' }); status(sale, 201);
  const partial = await admin.change('patch', `/admin/prices/${price.body.id}`, { revision: 1, gross_cents: '17900' });
  status(partial, 200); assert.equal(partial.body.gross_cents, '17900'); assert.equal(partial.body.revision, 2);
  status(await admin.change('patch', `/admin/prices/${price.body.id}`, { revision: 1, gross_cents: '10000' }), 409);
  // A partial update must not silently drop the stored sale window.
  status(await admin.change('patch', `/admin/prices/${sale.body.id}`, { revision: 1, sale_gross_cents: null }), 422);
  status(await admin.change('delete', `/admin/prices/${price.body.id}`, { revision: 1 }), 409);
  status(await admin.change('delete', `/admin/prices/${price.body.id}`, { revision: 2 }), 204);
  status(await admin.change('delete', `/admin/products/${created.body.id}`, { revision: 1 }), 409); // still has a price
  status(await admin.change('delete', `/admin/prices/${sale.body.id}`, { revision: 1 }), 204);
  status(await admin.change('delete', `/admin/products/${created.body.id}`, { revision: 1 }), 204);
  assert.equal(await db.product.count(), 0);
  const audits = await db.auditEvent.findMany({ where: { target_type: { in: ['product', 'price'] } } });
  assert.ok(audits.some(event => event.action === 'product.updated' || event.action === 'price.updated'));
  assert.equal(JSON.stringify(audits).includes('Synthetischer Produktentwurf'), false);
});

test('product drafts reject DB activation, foreign course links and revoked-session writes', async () => {
  const created = await admin.change('post', '/admin/products', { sku: 'FTB-BUNDLE-01', type: 'bundle', title: 'Paketentwurf',
    courses: [{ course_id: courseA.id }, { course_id: courseB.id }] }); status(created, 201);
  const id = created.body.id;
  assert.equal((await admin.get(`/admin/products/${id}`)).body.courses.length, 2);
  const list = await admin.get('/admin/products?limit=1'); status(list, 200);
  assert.ok(list.body.data.length <= 1); assert.equal(typeof list.body.total, 'number');
  status(await admin.get('/admin/products?limit=101'), 422);
  status(await admin.get('/admin/products?cursor=not-a-uuid'), 404);
  status(await admin.get(`/admin/products/${randomUUID()}`), 404);

  await assert.rejects(db.product.update({ where: { id }, data: { status: 'active' } }));
  const priceRow = await db.price.create({ data: { id: uuidv7(), product_id: id, currency: 'EUR', gross_cents: 1n,
    tax_category: 'standard', valid_from: new Date('2027-01-01T00:00:00Z'), status: 'draft', created_by: adminUser.id } });
  await assert.rejects(db.price.update({ where: { id: priceRow.id }, data: { status: 'active' } }));
  await assert.rejects(db.price.create({ data: { id: uuidv7(), product_id: id, currency: 'USD', gross_cents: 1n,
    tax_category: 'standard', valid_from: new Date('2027-01-01T00:00:00Z'), created_by: adminUser.id } }));
  await assert.rejects(db.product.create({ data: { id: uuidv7(), sku: 'bad sku', type: 'single', title: 'Titel', created_by: adminUser.id } }));
  await db.price.delete({ where: { id: priceRow.id } });

  // A second administrator edits a draft and is then demoted: the open session
  // must lose catalog access immediately, without a further product write.
  const supportUser = await db.user.findUniqueOrThrow({ where: { email_canonical: 'catalog-support@example.invalid' } });
  await grant(supportUser.id, ['participant', 'support', 'admin']);
  const second = new Browser();
  const secondLogin = await login(second, supportUser.email_canonical); status(secondLogin, 202);
  assert.equal(secondLogin.body.status, 'mfa_required');
  status(await second.change('post', '/auth/mfa/challenge', { recovery_code: supportRecovery[0] }), 200);
  status(await second.get('/admin/products'), 200);
  const secondCtx = await contextFor(second);
  const edited = await second.change('patch', `/admin/products/${id}`, { revision: 1, title: 'Paketentwurf gepflegt' });
  status(edited, 200); assert.equal(edited.body.revision, 2);
  status(await admin.change('put', `/admin/users/${supportUser.id}/roles`, { role_keys: ['participant', 'support'], reason_code: 'staff_change' }), 200);
  const { Products } = require('../../apps/api/dist/products');
  await assert.rejects(app.get(Products).list(secondCtx, 25, undefined), rejectedStatus(401));
  status(await second.get('/admin/products'), 401);
  status(await second.change('patch', `/admin/products/${id}`, { revision: 2, title: 'Nach Entzug' }), 401);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id } })).title, 'Paketentwurf gepflegt');
});

test('publication requires a fresh admin and a complete draft; published versions are immutable', async () => {
  const course = await createCourse('release-ready', { visibility: 'public', expected_module_count: null,
    expected_chapter_count: null, expected_exams_per_chapter: null });
  const moduleResponse = await releaseAdmin.change('post', `/admin/course-versions/${course.version_id}/modules`, { title: 'Modul', position: 1 });
  status(moduleResponse, 201);
  const chapterResponse = await releaseAdmin.change('post', `/admin/course-modules/${moduleResponse.body.id}/chapters`, { title: 'Kapitel', position: 1 });
  status(chapterResponse, 201);
  const state = await releaseAdmin.get(`/admin/courses/${course.id}/publication`); status(state, 200);
  assert.equal(state.body.status, 'draft');
  assert.ok(state.body.readiness.some(item => item.code === 'EMPTY_CHAPTER'));
  assert.equal(state.body.versions.length, 1);

  // Course managers never publish, even with a course assignment.
  status(await assign(course.id, managerUser.id, 'manager'), 200);
  const managerRelease = new Browser();
  status(await login(managerRelease, managerUser.email_canonical), 202);
  status(await managerRelease.change('post', '/auth/mfa/challenge', { recovery_code: managerRecovery[2] }), 200);
  status(await managerRelease.get(`/admin/courses/${course.id}/publication`), 403);
  status(await managerRelease.change('post', `/admin/courses/${course.id}/publish`, { version_id: course.version_id, revision: 1 }), 403);
  const recovery = releaseRecovery[0];
  const relogin = new Browser();
  status(await login(relogin, releaseAdminUser.email_canonical), 202);
  status(await relogin.change('post', '/auth/mfa/challenge', { recovery_code: recovery }), 200);
  const blocked = await relogin.change('post', `/admin/courses/${course.id}/publish`, { version_id: course.version_id, revision: 1 });
  status(blocked, 409); assert.equal(blocked.body.code, 'PUBLICATION_BLOCKED');
  assert.equal(await db.course.findUniqueOrThrow({ where: { id: course.id } }).then(row => row.status), 'draft');

  // Complete the draft, then publish with a fresh confirmation.
  const version = await db.courseVersion.findUniqueOrThrow({ where: { id: course.version_id } });
  status(await releaseAdmin.change('patch', `/admin/course-versions/${course.version_id}`, { revision: version.revision,
    subtitle: 'Synthetischer Untertitel', duration_minutes: 30 }), 200);
  status(await releaseAdmin.change('post', `/admin/course-chapters/${chapterResponse.body.id}/contents`,
    { block: { kind: 'paragraph', text: 'Synthetischer Lehrtext.' } }), 201);
  // Store only references: the public cover and the private lesson asset
  // are intentionally not interchangeable, even when both are ready images.
  const makeImage = visibility => db.mediaAsset.create({ data: { id: uuidv7(), source: 's3', storage_key: randomUUID(),
    original_name: 'bild.jpg', mime_detected: 'image/jpeg', size_bytes: 80n, visibility, status: 'ready' } });
  const cover = await makeImage('public'), lesson = await makeImage('private');
  const setCover = id => db.courseVersion.update({ where: { id: course.version_id }, data: { cover_media_id: id } });
  await assert.rejects(setCover(lesson.id), /COURSE_MEDIA_UNAVAILABLE/); await setCover(cover.id);
  const mediaRow = { id: uuidv7(), course_version_id: course.version_id, chapter_id: chapterResponse.body.id,
    kind: 'image', title: 'Lernbild', position: 77, media_asset_id: lesson.id };
  await assert.rejects(db.chapterContent.create({ data: { ...mediaRow, kind: 'video' } }), /COURSE_MEDIA_UNAVAILABLE/);
  await assert.rejects(db.chapterContent.create({ data: { ...mediaRow, media_asset_id: cover.id } }), /COURSE_MEDIA_UNAVAILABLE/);
  await db.chapterContent.create({ data: mediaRow });
  assert.ok((await releaseAdmin.get(`/admin/courses/${course.id}/publication`)).body.readiness
    .some(reason => reason.code === 'MEDIA_DELIVERY_NOT_IMPLEMENTED'));
  await db.chapterContent.delete({ where: { id: mediaRow.id } });
  assert.deepEqual((await releaseAdmin.get(`/admin/courses/${course.id}/publication`)).body.readiness, []);
  status(await releaseAdmin.change('post', '/auth/reauth', { password, recovery_code: releaseRecovery[1] }), 204);
  const published = await releaseAdmin.change('post', `/admin/courses/${course.id}/publish`,
    { version_id: course.version_id, revision: 2, visibility: 'unlisted' });
  status(published, 200); assert.equal(published.body.visibility, 'unlisted');
  const stored = await db.courseVersion.findUniqueOrThrow({ where: { id: course.version_id } });
  assert.equal(stored.state, 'published'); assert.equal(stored.published_by, releaseAdminUser.id); assert.ok(stored.published_at);
  const publicView = await new Browser().get('/courses/release-ready'); status(publicView, 404); // unlisted is not in the public list
  assert.deepEqual((await new Browser().get('/courses')).body.data.filter(item => item.slug === 'release-ready'), []);

  // Published versions are immutable through the API and through direct SQL.
  status(await releaseAdmin.change('patch', `/admin/course-versions/${course.version_id}`, { revision: 2, title: 'Nachträglich' }), 409);
  status(await releaseAdmin.change('post', `/admin/course-versions/${course.version_id}/modules`, { title: 'Später', position: 2 }), 409);
  status(await releaseAdmin.change('patch', `/admin/course-chapters/${chapterResponse.body.id}`, { revision: 1, title: 'Später' }), 409);
  await db.courseVersion.update({ where: { id: course.version_id }, data: { title: 'Direkt' } }); // no DB lock; the API is the guard
  await db.courseVersion.update({ where: { id: course.version_id }, data: { title: 'Entwurf release-ready' } });
  await assert.rejects(db.coursePublication.create({ data: { id: uuidv7(), course_id: courseA.id, course_version_id: course.version_id,
    version: 1, action: 'published', actor_user_id: releaseAdminUser.id } })); // version belongs to another course
  // A second publish of the same course is not possible without a new draft.
  status(await releaseAdmin.change('post', '/auth/reauth', { password, recovery_code: releaseRecovery[2] }), 204);
  status(await releaseAdmin.change('post', `/admin/courses/${course.id}/publish`, { version_id: course.version_id, revision: 2 }), 409);

  // A new draft is copied from the published version and stays editable.
  status(await releaseAdmin.change('post', '/auth/reauth', { password, recovery_code: releaseRecovery[3] }), 204);
  // Simulate a published media row; the current release API deliberately
  // cannot publish chapter media until there is an authorized learner route.
  await db.chapterContent.create({ data: mediaRow });
  await db.mediaAsset.update({ where: { id: lesson.id }, data: { status: 'quarantined' } });
  const failedCopy = await releaseAdmin.change('post', `/admin/courses/${course.id}/versions`, {});
  status(failedCopy, 409); assert.equal(failedCopy.body.code, 'COURSE_MEDIA_UNAVAILABLE');
  assert.equal(await db.courseVersion.count({ where: { course_id: course.id, state: 'draft' } }), 0);
  await db.mediaAsset.update({ where: { id: lesson.id }, data: { status: 'ready' } });
  const draft = await releaseAdmin.change('post', `/admin/courses/${course.id}/versions`, {});
  status(draft, 201); assert.equal(draft.body.version, 2);
  const detail = await releaseAdmin.get(`/admin/courses/${course.id}`);
  const copy = detail.body.versions.find(item => item.id === draft.body.version_id);
  assert.equal(copy.modules.length, 1); assert.equal(copy.modules[0].chapters[0]._count.contents, 2);
  assert.equal((await db.courseVersion.findUniqueOrThrow({ where: { id: copy.id } })).cover_media_id, cover.id);
  const copiedMedia = await db.chapterContent.findFirstOrThrow({ where: { course_version_id: copy.id, kind: 'image' } });
  assert.equal(copiedMedia.media_asset_id, lesson.id); assert.notEqual(copiedMedia.id, mediaRow.id);
  assert.equal(copiedMedia.body, null); assert.equal(copiedMedia.position, mediaRow.position);
  const copiedText = await releaseAdmin.get(`/admin/course-chapters/${copy.modules[0].chapters[0].id}/contents`);
  assert.equal(copiedText.body.data[0].body.blocks[0].text, 'Synthetischer Lehrtext.');
  assert.notEqual(copiedText.body.data[0].id, (await db.chapterContent.findFirstOrThrow({ where: { course_version_id: course.version_id } })).id);
  status(await releaseAdmin.change('post', `/admin/courses/${course.id}/versions`, {}), 409);
  status(await releaseAdmin.change('patch', `/admin/course-versions/${draft.body.version_id}`, { revision: 1, title: 'Zweite Fassung' }), 200);
  // The published version is untouched by draft edits.
  assert.equal((await db.courseVersion.findUniqueOrThrow({ where: { id: course.version_id } })).title, 'Entwurf release-ready');

  // Unpublishing is a fresh, explicit decision and retires the version.
  status(await releaseAdmin.change('post', '/auth/reauth', { password, recovery_code: releaseRecovery[4] }), 204);
  const unpublish = await releaseAdmin.change('post', `/admin/courses/${course.id}/unpublish`, { revision: 1 });
  status(unpublish, 200);
  assert.equal((await db.course.findUniqueOrThrow({ where: { id: course.id } })).status, 'draft');
  assert.equal(await db.courseVersion.count({ where: { course_id: course.id, state: 'published' } }), 0);
  const history = await db.coursePublication.findMany({ where: { course_id: course.id }, orderBy: { created_at: 'asc' } });
  assert.deepEqual(history.map(item => item.action), ['published', 'unpublished']);
  const audits = await db.auditEvent.findMany({ where: { target_ref: course.id, action: { in: ['course.published', 'course.unpublished'] } } });
  assert.ok(audits.length >= 2);
  status(await releaseAdmin.change('post', `/admin/courses/${course.id}/unpublish`, { revision: 1 }), 409);
  return { courseId: course.id, versionId: draft.body.version_id };
});

test('product activation enforces completeness, price rules and course dependencies', { timeout: 120000 }, async () => {
  const course = await createCourse('activation-course', { visibility: 'public' });
  const moduleResponse = await releaseAdmin.change('post', `/admin/course-versions/${course.version_id}/modules`, { title: 'Modul', position: 1 });
  const chapterResponse = await releaseAdmin.change('post', `/admin/course-modules/${moduleResponse.body.id}/chapters`, { title: 'Kapitel', position: 1 });
  const version = await db.courseVersion.findUniqueOrThrow({ where: { id: course.version_id } });
  status(await releaseAdmin.change('patch', `/admin/course-versions/${course.version_id}`, { revision: version.revision,
    subtitle: 'Untertitel', duration_minutes: 20 }), 200);
  status(await releaseAdmin.change('post', `/admin/course-chapters/${chapterResponse.body.id}/contents`,
    { block: { kind: 'paragraph', text: 'Text.' } }), 201);
  status(await releaseAdmin.change('post', '/auth/reauth', { password, recovery_code: releaseRecovery[5] }), 204);
  status(await releaseAdmin.change('post', `/admin/courses/${course.id}/publish`, { version_id: course.version_id, revision: 2 }), 200);

  const created = await releaseAdmin.change('post', '/admin/products', { sku: 'ACT-SINGLE-01', type: 'single', title: 'Aktivierbares Produkt',
    description: 'Synthetische Beschreibung.', courses: [{ course_id: course.id }] });
  status(created, 201);
  const productId = created.body.id;
  const draftPrice = await releaseAdmin.change('post', `/admin/products/${productId}/prices`,
    { currency: 'EUR', gross_cents: '9900', tax_category: 'standard', valid_from: '2026-01-01T00:00Z' });
  status(draftPrice, 201);
  const inactiveState = await releaseAdmin.get(`/admin/products/${productId}/activation`); status(inactiveState, 200);
  assert.equal(inactiveState.body.status, 'draft');
  assert.deepEqual(inactiveState.body.blockers, []);

  // Activation needs a fresh confirmation and a matching revision. A session
  // whose reauthentication is older than five minutes must confirm again; one
  // confirmation then covers every release action inside that window.
  const activation = async (revision, browser = releaseAdmin) => browser.change('post', `/admin/products/${productId}/activate`, { revision });
  await db.authSession.updateMany({ where: { user_id: releaseAdminUser.id, kind: 'backoffice', revoked_at: null },
    data: { reauthenticated_at: new Date(Date.now() - 6 * 60_000) } });
  const staleConfirmation = await activation(1);
  status(staleConfirmation, 403); assert.equal(staleConfirmation.body.code, 'REAUTH_REQUIRED');
  status(await releaseAdmin.change('post', '/auth/reauth', { password, recovery_code: releaseRecovery[6] }), 204);
  status(await activation(99), 409);
  const activated = await activation(1); status(activated, 200); assert.equal(activated.body.status, 'active');
  const activeRow = await db.product.findUniqueOrThrow({ where: { id: productId } });
  assert.ok(activeRow.activated_at); assert.equal(activeRow.activated_by, releaseAdminUser.id);
  await assert.rejects(db.product.update({ where: { id: productId }, data: { status: 'active', activated_by: null,
    activated_at: null } }));
  // Drafts may overlap; activating a second overlapping window is rejected.
  const second = await releaseAdmin.change('post', `/admin/products/${productId}/prices`,
    { currency: 'EUR', gross_cents: '8900', tax_category: 'standard', valid_from: '2026-01-01T00:00Z' });
  status(second, 201);
  status(await releaseAdmin.change('post', `/admin/prices/${draftPrice.body.id}/activate`, { revision: 1 }), 200);
  const overlap = await releaseAdmin.change('post', `/admin/prices/${second.body.id}/activate`, { revision: 1 });
  status(overlap, 409); assert.equal(overlap.body.code, 'PRICE_OVERLAP');
  // An activated course cannot be unpublished while the product is active.
  const blockedUnpublish = await releaseAdmin.change('post', `/admin/courses/${course.id}/unpublish`, { revision: 1 });
  status(blockedUnpublish, 409); assert.equal(blockedUnpublish.body.code, 'COURSE_STILL_IN_ACTIVE_PRODUCT');
  // Removing a required link from an active product is rejected by the database.
  await assert.rejects(db.productCourse.delete({ where: { product_id_course_id: { product_id: productId, course_id: course.id } } }));
  const deactivated = await releaseAdmin.change('post', `/admin/products/${productId}/deactivate`, { revision: 2 });
  status(deactivated, 200); assert.equal(deactivated.body.status, 'inactive');
  assert.equal(await db.price.count({ where: { product_id: productId, status: 'active' } }), 0);
  status(await releaseAdmin.change('post', `/admin/courses/${course.id}/unpublish`, { revision: 1 }), 200);

  // A bundle needs two different, published courses.
  const bundle = await releaseAdmin.change('post', '/admin/products', { sku: 'ACT-BUNDLE-01', type: 'bundle', title: 'Paket',
    description: 'Synthetisch.', courses: [{ course_id: course.id }] });
  status(bundle, 201);
  status(await releaseAdmin.change('post', `/admin/products/${bundle.body.id}/prices`,
    { currency: 'EUR', gross_cents: '19900', tax_category: 'standard', valid_from: '2026-01-01T00:00Z' }), 201);
  const bundleBlocked = await releaseAdmin.change('post', `/admin/products/${bundle.body.id}/activate`, { revision: 1 });
  status(bundleBlocked, 409); assert.equal(bundleBlocked.body.code, 'ACTIVATION_BLOCKED');
  assert.ok(bundleBlocked.body.details.BUNDLE_COURSE_COUNT);
  // Drafts keep overlapping prices; only active windows are constrained.
  const drafts = await db.price.findMany({ where: { product_id: productId, status: 'draft' } });
  assert.equal(drafts.length, 1);
});

test('media metadata defaults to private, binds one immutable source and cannot publish unscanned files', async () => {
  const create = overrides => db.mediaAsset.create({ data: { id: uuidv7(), source: 's3', storage_key: randomUUID(),
    original_name: 'titel.jpg', mime_detected: 'image/jpeg', size_bytes: 100n, uploaded_by: adminUser.id, ...overrides } });
  const asset = await create({ sha256: Buffer.alloc(32) });
  assert.equal(asset.status, 'pending_scan'); assert.equal(asset.visibility, 'private');
  for (const invalid of [{ source: 'other' }, { storage_key: null }, { storage_key: '../titel.jpg' },
    { video_external_id: 'clip' }, { source: 'video_provider', storage_key: null }, { size_bytes: -1n },
    { sha256: Buffer.alloc(31) }, { visibility: 'public' }, { status: 'unknown' }]) {
    await assert.rejects(create(invalid), /check constraint/i);
  }
  await assert.rejects(create({ storage_key: asset.storage_key }), { code: 'P2002' });
  await assert.rejects(db.mediaAsset.update({ where: { id: asset.id }, data: { storage_key: randomUUID() } }), /MEDIA_REFERENCE_IMMUTABLE/);
  await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'ready', visibility: 'public' } });
  await assert.rejects(db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'quarantined' } }), /media_assets_public_ready/);
  const video = await create({ source: 'video_provider', storage_key: null, video_external_id: uuidv7() });
  assert.equal(video.storage_key, null); assert.equal(video.visibility, 'private');
});
