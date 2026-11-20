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
    if (options.key) r.set('Idempotency-Key', options.key);
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
  for(const path of ['/admin/audit-events','/admin/dashboard','/admin/dashboard/finance','/admin/automation-jobs','/admin/certificate-mail-template']) status(await browser.get(path),403);
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
  // Without the disposable store, keep running the network-free signing tests.
  Object.assign(process.env, { MEDIA_S3_ENDPOINT: 'https://objects.example.invalid', MEDIA_S3_BUCKET: 'trainerb-test',
    MEDIA_S3_REGION: 'eu-central-1', MEDIA_S3_ACCESS_KEY_ID: 'synthetic', MEDIA_S3_SECRET_ACCESS_KEY: 'synthetic-only' });
  if (process.env.TRAINERB_TEST_S3_ORIGIN) {
    assert.match(process.env.TRAINERB_TEST_S3_ORIGIN, /^https:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(process.env.TRAINERB_TEST_S3_SECRET);
    Object.assign(process.env, { MEDIA_S3_ENDPOINT: process.env.TRAINERB_TEST_S3_ORIGIN, MEDIA_S3_REGION: 'us-east-1',
      MEDIA_S3_ACCESS_KEY_ID: 'trainerb-integration', MEDIA_S3_SECRET_ACCESS_KEY: process.env.TRAINERB_TEST_S3_SECRET });
  }
  if(process.env.TRAINERB_CERTIFICATE_BROWSER==='yes')Object.assign(process.env,{STRIPE_SECRET_KEY:'sk_test_qualification_fixture',STRIPE_PUBLISHABLE_KEY:'pk_test_qualification_fixture',STRIPE_WEBHOOK_SECRET:'whsec_qualification_fixture'});
  app = await createApplication(); await app.listen(process.env.TRAINERB_CERTIFICATE_BROWSER === 'yes' ? 4000 : 0, '127.0.0.1'); server = app.getHttpServer(); db = app.get(Database);
  await db.$executeRawUnsafe('TRUNCATE TABLE newsletter_feedback, newsletter_subscribers, pages, legal_documents, courses, users, roles, permissions, email_templates, email_template_versions, email_outbox, automation_jobs, automation_job_attempts RESTART IDENTITY CASCADE');
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
  assert.equal((await admin.get('/health')).body.exams_enabled, true);
  assert.equal((await new Browser().get('/shop/products')).body.sales_enabled, false);
  status(await new Browser().get('/cart'), 401);
});

test('website image needs a clean scan, matching rights evidence and a distinct reviewer; withdrawal stops fresh delivery', {skip:!process.env.TRAINERB_TEST_S3_ORIGIN,timeout:90000},async()=>{
 const endpoint='/admin/site-image-uploads',cfg=require('../../apps/api/dist/config').getConfig(),old={mediaStore:cfg.mediaStore,quarantineStore:cfg.quarantineStore};
 const sharp=require('sharp'),{AwsClient}=require('aws4fetch'),{scanNext,inspectUpload}=require('../../apps/api/dist/media-scan'),{withTestClamd}=require('../scanner/test-clamd.cjs'),{promoteNext}=require('../../apps/api/dist/media-promote');
 const src={...old.mediaStore,bucket:'site-review-source'},dst={...old.mediaStore,bucket:'site-review-target'},aws=new AwsClient({...src,service:'s3'});
 const img=await sharp({create:{width:3,height:2,channels:3,background:'red'}}).jpeg().withMetadata().toBuffer();const sha=require('crypto').createHash('sha256').update(img).digest('hex');
 const post=async(who,bytes=img,name='Bild.jpg')=>request(server).post('/api/v1'+endpoint).set('Origin',origin).set('X-CSRF-Token',(await who.get('/auth/csrf')).body.csrf_token).set('Cookie',who.cookie()).set('Content-Type','application/octet-stream').set('X-Upload-Name',name).send(bytes);
 try{Object.assign(cfg,{quarantineStore:src,mediaStore:dst});for(const store of [src,dst])assert.equal((await aws.fetch(`${store.origin}/${store.bucket}`,{method:'PUT'})).status,200);
 status(await post(instructor),403);status(await post(admin,Buffer.from('%PDF-1.3 xxx %%EOF'),'a.pdf'),422);const sent=await post(admin);status(sent,201);const id=sent.body.id,path=endpoint+'/'+id+'/approve';
 const proof={sha256:sha,rights_ref:'TEST-ONLY-34',public_use_confirmed:true};status(await releaseAdmin.change('post',path,proof),409);
 await withTestClamd(async({socket})=>{assert.equal((await scanNext(db,r=>inspectUpload(r,src,socket))).id,id);});
 status(await admin.change('post',path,proof),409);status(await releaseAdmin.change('post',path,{...proof,sha256:'0'.repeat(64)}),409);status(await releaseAdmin.change('post',path,proof,{noCsrf:true}),403);
 status(await releaseAdmin.change('post',path,proof),200);const p=await promoteNext(db,{source:src,destination:dst});assert.equal(p.upload_id,id);assert.equal(p.error,null);
 const asset=await db.mediaAsset.findUniqueOrThrow({where:{id:p.asset_id}});assert.equal(asset.visibility,'public');const url=`${dst.origin}/${dst.bucket}/${asset.storage_key}`;assert.equal((await fetch(url)).status,403);
 const bytes=Buffer.from(await(await aws.fetch(url)).arrayBuffer());assert.equal((await sharp(bytes).metadata()).exif,undefined);assert.ok(!bytes.equals(img));
 status(await admin.get('/admin/page-images/'+asset.id),302);status(await releaseAdmin.change('post',endpoint+'/'+id+'/withdraw',{}),200);status(await admin.get('/admin/page-images/'+asset.id),404);
 await assert.rejects(db.courseMediaUpload.update({where:{id},data:{rights_ref:'OTHER'}}),/UPLOAD_ORIGIN_IMMUTABLE/);
 const queued=await post(admin);status(queued,201);const q=queued.body.id;await withTestClamd(async({socket})=>{assert.equal((await scanNext(db,r=>inspectUpload(r,src,socket))).id,q);});
 status(await releaseAdmin.change('post',endpoint+'/'+q+'/approve',proof),200);status(await admin.change('post',endpoint+'/'+q+'/withdraw',{}),200);
 assert.equal(await promoteNext(db,{source:src,destination:dst}),null);await assert.rejects(db.courseMediaUpload.update({where:{id:q},data:{rights_withdrawn_at:null}}),/RIGHTS_WITHDRAWAL_FINAL/);
 }finally{Object.assign(cfg,old);}
});

test('mail library pins versions, checks supported variables and keeps actionable secrets only in the body',async()=>{
 const base='/admin/mail-templates',keys=await admin.get(base);status(keys,200);assert.ok(keys.body.keys.includes('activation'));status(await support.get(base),403);status(await admin.get(base+'/not_a_template'),404);
 for(const k of keys.body.keys){const current=await admin.get(base+'/'+k);status(current,200);assert.ok(current.body.published.id);}
 const path=base+'/activation',v=(await admin.get(path)).body.published,payload={base_id:v.id,subject:'Dein Konto bestätigen',text:v.body_text_template+'\nDanke.'};
 for(const patch of [{subject:'{{activation_url}}'},{text:'Ohne Aktivierungslink.'},{text:'https://invalid.example/?q={{activation_url}}'},{text:'Weiter: X{{activation_url}}'},{text:'{{token}}\n{{activation_url}}'}])status(await admin.change('post',path+'/drafts',{...payload,...patch}),422);
 status(await admin.change('post',path+'/drafts',payload,{noCsrf:true}),403);const draft=await admin.change('post',path+'/drafts',payload);status(draft,201);status(await admin.change('post',path+'/publish',{draft_id:draft.body.id}),200);
 const queued=await db.emailOutbox.findFirstOrThrow({where:{template_version_id:v.id}});assert.equal(queued.template_version_id,v.id);
 await assert.rejects(db.emailTemplateVersion.update({where:{id:v.id},data:{body_text_template:'Ersatz'}}),/MAIL_TEMPLATE_VERSION_IMMUTABLE/);
});

test('offline recovery binds the replacement device, invalidates sessions and codes, and cannot replay an old approval',async()=>{
 const {replaceLostFactor}=require('../../apps/api/dist/offline-mfa');const fixture=await register('offline-recovery');await grant(fixture.user.id,['participant','support']);
 const codes=await enroll(fixture.browser,fixture.email),id=fixture.user.id,old=await db.userMfaFactor.findFirstOrThrow({where:{user_id:id,status:'active'}}),secret=new OTPAuth.Secret({size:20});
 const replace=code=>replaceLostFactor(db,id,old.id,'IR-2026-1234',secret.base32,code);
 await assert.rejects(replace('bad'),/device proof/);status(await fixture.browser.get('/me'),200);
 const totp=new OTPAuth.TOTP({algorithm:'SHA1',digits:6,period:30,secret});const recovery=await replace(totp.generate());assert.equal(recovery.length,10);status(await fixture.browser.get('/me'),401);await assert.rejects(replace(totp.generate()),/Factor changed/);
 const browser=new Browser();status(await login(browser,fixture.email),202);status(await browser.change('post','/auth/mfa/challenge',{recovery_code:codes[0]}),401);status(await browser.change('post','/auth/mfa/challenge',{recovery_code:recovery[0]}),200);
 assert.equal(await db.auditEvent.count({where:{action:'mfa.offline_replaced',target_ref:id}}),1);
});

test('account data copy requires fresh identity, ignores no extra identity selectors and returns only projected own records',async()=>{
 const path='/me/export',fetch=(body,options)=>participant.change('post',path,body,options);
 status(await fetch({section:'profile'}),403);status(await participant.change('post','/auth/reauth',{password}),204);
 status(await fetch({section:'profile'},{noCsrf:true}),403);status(await fetch({section:'profile',user_id:adminUser.id}),400);status(await fetch({section:'__proto__'}),422);
 const own=(await participant.get('/me')).body.id;
 const bills=[own,adminUser.id].map((user_id,i)=>({id:uuidv7(),user_id,first_name:'Test',last_name:'Kopie',street:'Teststraße '+(i+1),postal_code:'10115',city:'Berlin',country:'DE'}));
 await db.billingProfile.createMany({data:bills});try{
 for(const section of ['profile','billing','orders','acceptances','invoices','credits','access','progress','exams','completions','certificates']){
  const r=await fetch({section});status(r,200);if(section==='profile'){assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].email,'catalog-participant@example.invalid');assert.ok(!('password_hash' in r.body.data[0]));}else if(section==='billing'){assert.deepEqual(r.body.data.map(b=>b.id),[bills[0].id]);}else assert.deepEqual(r.body.data,[]);
 }
 }finally{await db.billingProfile.deleteMany({where:{id:{in:bills.map(b=>b.id)}}});}
});

test('privacy intake is neutral, separates verification from fulfilment and erases case contact at closure',async()=>{
 const anon=new Browser(),root='/admin/data-requests',email='privacy-contact@example.invalid',payload={type:'deletion',email};
 status(await anon.change('post','/privacy/requests',payload,{noCsrf:true}),403);
 const response=await anon.change('post','/privacy/requests',payload);status(response,202);assert.deepEqual(response.body,{received:true});
 for(const caller of [support,manager,participant])status(await caller.get(root),403);
 const queue=await admin.get(root);status(queue,200);const row=queue.body.data.find(r=>r.type==='deletion');assert.ok(row);assert.ok(!JSON.stringify(queue.body).includes(email));
 const base=root+'/'+row.id, step=a=>admin.change('post',base+'/advance',{action:a});
 status(await support.change('post',base+'/contact',{}),403);status(await admin.change('post',base+'/contact',{},{noCsrf:true}),403);
 assert.equal((await admin.change('post',base+'/contact',{})).body.email,email);status(await step('fulfilled'),409);
 status(await step('begin_identification'),200);status(await step('fulfilled'),409);status(await step('identity_verified'),200);status(await step('fulfilled'),200);
 status(await step('fulfilled'),409);status(await admin.change('post',base+'/contact',{}),404);
 const closed=await db.dataRequest.findUniqueOrThrow({where:{id:row.id}});assert.equal(closed.contact_cipher,null);assert.equal(closed.contact_key_id,null);assert.ok(closed.identity_verified_at);assert.equal(closed.processed_by,adminUser.id);
 const audit=await db.auditEvent.findMany({where:{target_type:'data_request',target_ref:row.id}});assert.equal(audit.length,4);assert.ok(!JSON.stringify(audit).includes(email));
});

test('newsletter consent, audience freeze, unsubscribe, cancellation and complaint suppression are independent of purchases',async()=>{
  const {dispatchNewsletter}=require('../../apps/api/dist/newsletter'),outbox=app.get(require('../../apps/api/dist/outbox').Outbox);
  const {MailWorker}=require('../../apps/api/dist/mail-worker');const messages=[];
  const worker=new MailWorker(db,{sendMail:async m=>{messages.push(m);return {accepted:[m.to],messageId:m.messageId};}});
  const publicClient=new Browser(),root='/admin/newsletter/campaigns',signup='/newsletter/subscribe',verify='/newsletter/confirm';
  const runMail=async id=>{const job=await db.automationJob.findFirstOrThrow({where:{ref_id:id,kind:'email.send'}});assert.equal(await worker.runOne(job.id),true);return (await db.emailOutbox.findUniqueOrThrow({where:{id}})).status;};
  const draft={subject:'Neu in der Akademie',body:'Nur synthetische Daten.',audience:'kurse'};
  for(const caller of [participant,manager,support]){status(await caller.get(root),403);status(await caller.change('post',root,draft),403);}
  status(await publicClient.get(root),401);status(await admin.change('post',root,draft,{noCsrf:true}),403);
  process.env.NEWSLETTER_CONSENT_WORDING='Synthetischer Einwilligungstext.';process.env.NEWSLETTER_DELIVERY_ENABLED='true';
  Object.assign(process.env,{POSTMARK_FEEDBACK_PASSWORD:'synthetic-only-'.repeat(4),POSTMARK_SERVER_ID:'42',POSTMARK_BROADCAST_STREAM:'fixture'});
  try {
    const doc=await admin.change('post','/admin/commerce/legal',{kind:'privacy',wording:'Datenschutz im Test.'});status(doc,201);
    status(await admin.change('post',`/admin/commerce/legal/${doc.body.id}/activate`,{}),200);
    const p=(await publicClient.get('/newsletter/policy')).body;
    const form=(email,topic='kurse')=>({email,topic,policy:p.policy,accepted:true});
    const code=async(email,topic='kurse')=>{
      status(await publicClient.change('post',signup,form(email,topic)),202);
      const mail=await db.emailOutbox.findFirstOrThrow({where:{to_email:email,template_version:{template:{key:'newsletter_confirm'}}},orderBy:{created_at:'desc'}});
      assert.deepEqual(mail.variables_public,{first_name:''});assert.equal(await runMail(mail.id),'accepted');
      return messages.at(-1).text.split('#token=')[1].split('\n')[0];
    };
    status(await publicClient.change('post',signup,{...form('a@example.invalid'),accepted:false}),422);
    status(await publicClient.change('post',signup,{...form('a@example.invalid'),policy:'old'}),409);
    const token=await code('eins@example.invalid');status(await publicClient.get(verify+'?token='+token),404);
    const attempts=await Promise.all([1,2].map(()=>publicClient.change('post',verify,{token})));assert.deepEqual(attempts.map(r=>r.status).sort(),[200,410]);
    const leave=attempts.find(r=>r.status===200).body.unsubscribe_token;
    const token2=await code('zwei@example.invalid');status(await publicClient.change('post',verify,{token:token2}),200);
    const token3=await code('drei@example.invalid','akademie');status(await publicClient.change('post',verify,{token:token3}),200);
    const stale=await code('pending@example.invalid');
    const pending=await db.newsletterSubscriber.findUniqueOrThrow({where:{email:'pending@example.invalid'}});
    await db.newsletterProof.update({where:{subscriber_id:pending.id},data:{expires_at:new Date(Date.now()-1)}});
    status(await publicClient.change('post',verify,{token:stale}),410);
    const {runRetention}=require('../../apps/api/dist/retention');
    for(const dryRun of [true,false]){const report=await db.$transaction(tx=>runRetention(tx,{dryRun}));assert.equal(report.newsletter_unconfirmed_deleted,1);assert.equal(await db.newsletterSubscriber.count({where:{id:pending.id}}),dryRun?1:0);}
    await code('pending2@example.invalid');
    const plan=async()=>{const c=await admin.change('post',root,draft);status(c,201);const path=`${root}/${c.body.id}/schedule`,time={scheduled_at:new Date().toISOString()};
      status(await admin.change('post',path,time),200);status(await admin.change('post',path,time),409);await dispatchNewsletter(db,outbox);return c.body.id;};
    const first=await plan();let sends=await db.newsletterSend.findMany({where:{campaign_id:first}});assert.equal(sends.length,2);
    status(await publicClient.change('post','/newsletter/unsubscribe',{token:leave}),200);
    const delivered=await Promise.all(sends.map(s=>runMail(s.outbox_id)));assert.deepEqual(delivered.sort(),['accepted','suppressed']);
    const campaign=messages.find(m=>m.subject===draft.subject);assert.equal(campaign.to,'zwei@example.invalid');assert.ok(campaign.text.includes('/newsletter/abmelden#token='));
    const link=new URL(campaign.headers['List-Unsubscribe'].slice(1,-1)).pathname;
    status(await request(server).get(link),404);assert.equal((await db.newsletterSubscriber.findUnique({where:{email:'zwei@example.invalid'}})).status,'confirmed');
    status(await request(server).post(link).type('form').send({'List-Unsubscribe':'One-Click'}),200);
    status(await request(server).post(link).type('form').send({'List-Unsubscribe':'One-Click'}),200);
    const next=await code('eins@example.invalid');status(await publicClient.change('post',verify,{token:next}),200);
    status(await publicClient.change('post','/newsletter/unsubscribe',{token:leave}),200); // prior epoch cannot revoke new consent
    const repeat=await plan();sends=await db.newsletterSend.findMany({where:{campaign_id:repeat}});assert.equal(sends.length,1);
    status(await admin.change('post',root+'/'+repeat+'/cancel',{}),200);assert.equal(await runMail(sends[0].outbox_id),'suppressed');
    const outbound=await plan();const campaignMail=await db.newsletterSend.findFirstOrThrow({where:{campaign_id:outbound}});assert.equal(await runMail(campaignMail.outbox_id),'accepted');
    const hdr=messages.at(-1).headers;assert.equal(hdr['X-PM-Metadata-trainerb_outbox'],campaignMail.outbox_id);
    const feedback={RecordType:'Bounce',Type:'HardBounce',ID:731,ServerID:42,MessageStream:hdr['X-PM-Message-Stream'],Metadata:{trainerb_outbox:campaignMail.outbox_id},Email:'eins@example.invalid'};
    const notify=(p,pass=process.env.POSTMARK_FEEDBACK_PASSWORD)=>request(server).post('/api/v1/newsletter/feedback/postmark').auth('trainerb',pass).send(p);
    status(await notify(feedback,'wrong'),401);
    for(const override of [{ServerID:43},{MessageStream:'other'},{Type:'SoftBounce'},{Metadata:{}},{Email:'other@example.invalid'}])status(await notify({...feedback,...override}),200);
    assert.equal(await db.newsletterFeedback.count(),0);
    const blocked=await plan();for(const r of await Promise.all([notify(feedback),notify(feedback)]))status(r,200);
    assert.equal(await db.newsletterFeedback.count(),1);assert.equal((await db.newsletterSubscriber.findUnique({where:{email:feedback.Email}})).status,'bounced');
    status(await notify({...feedback,ID:732,RecordType:'SpamComplaint'}),200);assert.equal((await db.newsletterSubscriber.findUnique({where:{email:feedback.Email}})).status,'complained');
    status(await admin.change('post','/admin/newsletter/suppress',{email:'eins@example.invalid',reason:'complained'}),200);
    assert.equal(await runMail((await db.newsletterSend.findFirstOrThrow({where:{campaign_id:blocked}})).outbox_id),'suppressed');
    const n=await db.newsletterProof.count();status(await publicClient.change('post',signup,form('eins@example.invalid')),202);assert.equal(await db.newsletterProof.count(),n);
    const evidence=await db.newsletterConsentEvent.findFirstOrThrow({where:{action:'grant'}});assert.equal(evidence.privacy_id,doc.body.id);assert.equal(evidence.wording,p.wording);
    await assert.rejects(db.newsletterConsentEvent.update({where:{id:evidence.id},data:{action:'withdraw'}}),/NEWSLETTER_EVIDENCE_IMMUTABLE/);
    assert.equal((await admin.get(root)).body.data.find(c=>c.id===first).accepted,1);
  }finally{for(const k of ['POSTMARK_FEEDBACK_PASSWORD','POSTMARK_SERVER_ID','POSTMARK_BROADCAST_STREAM'])delete process.env[k];delete process.env.NEWSLETTER_CONSENT_WORDING;delete process.env.NEWSLETTER_DELIVERY_ENABLED;}
});

test('verified deletion erases only a matched participant profile, withdraws marketing and invalidates access atomically',async()=>{
 const fixture=await register('erase-fixture');status(await login(fixture.browser,fixture.email),200);
 const intake=await new Browser().change('post','/privacy/requests',{type:'deletion',email:fixture.email});status(intake,202);
 const record=await db.dataRequest.findFirstOrThrow({where:{type:'deletion',status:'open'},orderBy:{id:'desc'}}),root='/admin/data-requests/'+record.id;
 const perform=(user_id=fixture.user.id,reviewed=true)=>admin.change('post',root+'/erase-profile',{user_id,reviewed});
 status(await perform(),409);status(await admin.change('post',root+'/advance',{action:'begin_identification'}),200);status(await perform(),409);
 status(await admin.change('post',root+'/advance',{action:'identity_verified'}),200);status(await perform(managerUser.id),409);status(await perform(fixture.user.id,false),422);
 const doc=await admin.change('post','/admin/commerce/legal',{kind:'privacy',wording:'Nur Fixture für Löschprüfung.'});status(doc,201);
 const sid=uuidv7(),epoch=uuidv7();await db.newsletterSubscriber.create({data:{id:sid,email:fixture.email,status:'confirmed',epoch,topic:'kurse',policy:'test'}});
 await db.newsletterConsentEvent.create({data:{id:uuidv7(),subscriber_id:sid,epoch,action:'grant',policy:'test',wording:'Test',topic:'kurse',privacy_id:doc.body.id}});
 await db.billingProfile.create({data:{id:uuidv7(),user_id:fixture.user.id,first_name:'Test',last_name:'Kopie',street:'Teststraße',postal_code:'10115',city:'Berlin',country:'DE'}});
 status(await perform(),200);status(await perform(),409);status(await fixture.browser.get('/me'),401);status(await login(new Browser(),fixture.email),401);
 const user=await db.user.findUniqueOrThrow({where:{id:fixture.user.id}});assert.equal(user.status,'deleted');for(const field of ['first_name','last_name','password_hash','email_original','email_canonical'])assert.equal(user[field],null);
 assert.equal(await db.billingProfile.count({where:{user_id:user.id}}),0);assert.equal(await db.newsletterConsentEvent.count({where:{epoch,action:'withdraw'}}),1);
 const linked=await db.dataRequest.findUniqueOrThrow({where:{id:record.id}});assert.equal(linked.status,'in_progress');assert.equal(linked.erased_user_id,user.id);assert.ok(linked.profile_erased_at);
 status(await admin.change('post',root+'/advance',{action:'not_applicable'}),409);status(await admin.change('post',root+'/advance',{action:'partially_retained'}),200);
});

test('editorial pages remain private until release; drafts, release and withdrawal use revisions',async()=>{
  const visitor=new Browser(), path='/admin/pages', publicPath='/pages/redaktionstest';
  const content={title:'Testseite',body:'Absatz eins.',description:'Testbeschreibung'};
  const create={slug:'redaktionstest',...content};
  status(await visitor.get(path),401);
  for(const viewer of [participant,manager,instructor,support]) {
    status(await viewer.get(path),403);status(await viewer.change('post',path,create),403);
    status(await viewer.get('/admin/legal-documents/terms'),403);
  }
  status(await admin.change('post',path,create,{noCsrf:true}),403);
  status(await admin.change('post',path,{...create,slug:'../agb'}),422);
  const created=await admin.change('post',path,create);status(created,201);
  status(await admin.change('post',path,create),409);const id=created.body.id,edit=path+'/'+id;
  status(await visitor.get(publicPath),404);assert.equal((await visitor.get('/pages')).body.data.length,0);
  const info=async()=>(await admin.get(edit)).body;
  const draft=await info();const publish=d=>admin.change('post',edit+'/publish',{revision:d.revision,version_id:d.latest.id});
  status(await publish(draft),200);assert.deepEqual((await visitor.get(publicPath)).body,{version:1,...content});
  const published=await info(),save=()=>admin.change('post',edit+'/drafts',{...content,title:'Neue Fassung',revision:published.revision});
  assert.deepEqual((await Promise.all([save(),save()])).map(x=>x.status).sort(),[201,409]);
  assert.equal((await visitor.get(publicPath)).body.title,content.title);status(await publish(draft),409);
  const updated=await info();status(await publish(updated),200);
  assert.deepEqual((await visitor.get('/pages')).body.data,[{slug:create.slug,title:'Neue Fassung'}]);
  await assert.rejects(db.pageVersion.update({where:{id:updated.latest.id},data:{body:'overwrite'}}),/PAGE_VERSION_IMMUTABLE/);
  const live=await info();status(await admin.change('post',edit+'/withdraw',{revision:live.revision,version_id:live.published.id}),200);
  status(await visitor.get(publicPath),404);assert.deepEqual((await visitor.get('/pages')).body.data,[]);
  assert.equal(await db.auditEvent.count({where:{target_ref:id,action:'page.published'}}),2);
});

test('page graphics are versioned and only published, still public approved raster images may be served',async()=>{
  const visitor=new Browser(),root='/admin/pages',slug='grafiktest',page='/pages/'+slug,images='/admin/page-images';
  const content={slug,title:'Grafikseite',body:'Testtext',banner:'Hinweis',button_label:'Ansehen',button_path:'/kurse'};
  const asset=await db.mediaAsset.create({data:{id:uuidv7(),source:'s3',storage_key:randomUUID(),mime_detected:'image/png',original_name:'Beispiel.png',size_bytes:12n}});
  const withImage={...content,image_id:asset.id,image_alt:'Synthetische Abbildung'};
  status(await visitor.get(images),401);status(await manager.get(images+'/'+asset.id),403);
  status(await admin.change('post',root,withImage),422);status(await admin.get(images+'/'+asset.id),404);
  await db.mediaAsset.update({where:{id:asset.id},data:{status:'ready',visibility:'public'}});
  for(const bad of [{button_path:'https://example.invalid'},{image_alt:null},{button_path:null}])status(await admin.change('post',root,{...withImage,...bad}),422);
  assert.ok((await admin.get(images)).body.data.some(r=>r.id===asset.id));status(await admin.get(images+'/'+asset.id),302);
  const created=await admin.change('post',root,withImage);status(created,201);const edit=root+'/'+created.body.id;
  const detail=(await admin.get(edit)).body;const version={revision:detail.revision,version_id:detail.latest.id};
  const publicImage=page+'/image/1';status(await visitor.get(publicImage),404);
  await db.mediaAsset.update({where:{id:asset.id},data:{visibility:'private'}});
  status(await admin.change('post',edit+'/publish',version),422);status(await visitor.get(page),404);
  await db.mediaAsset.update({where:{id:asset.id},data:{visibility:'public'}});
  status(await admin.change('post',edit+'/publish',version),200);
  const published=(await visitor.get(page)).body;assert.equal(published.image_url,'/api/v1'+publicImage);assert.equal(published.image_alt,withImage.image_alt);
  assert.equal(published.button_path,'/kurse');assert.equal(published.banner,content.banner);assert.equal(published.image_id,undefined);
  status(await visitor.get(publicImage),302);status(await visitor.get(page+'/image/2'),404);
  await assert.rejects(db.pageVersion.update({where:{id:detail.latest.id},data:{state:'retired',banner:'Austausch'}}),/PAGE_VERSION_IMMUTABLE/);
  await db.mediaAsset.update({where:{id:asset.id},data:{visibility:'private',status:'quarantined'}});
  const removed=await visitor.get(publicImage);status(removed,404);assert.equal(removed.headers.location,undefined);
  assert.equal((await visitor.get(page)).body.image_url,undefined);
  status(await admin.change('post',edit+'/withdraw',{...version,revision:version.revision+1}),200);
});

test('editorial menu is revisioned per area and projects only visible published targets in configured order',async()=>{
  const visitor=new Browser(), root='/admin/navigation/',pub=async()=>(await visitor.get('/navigation')).body;
  const read=async(area)=>(await admin.get(root+area)).body;
  const write=(area,revision,items,who=admin,opts)=>who.change('put',root+area,{revision,items},opts);
  status(await visitor.get(root+'header'),401);
  for(const who of [participant,support,manager,instructor]) {status(await who.get(root+'header'),403);status(await write('header',0,[],who),403);}
  status(await admin.get(root+'system'),404);
  const {revision:h}=await read('header'),{revision:f}=await read('footer');
  status(await write('header',h,[],admin,{noCsrf:true}),403);
  const targets=[];
  for(const slug of ['menutest-a','menutest-b']){
    const created=await admin.change('post','/admin/pages',{slug,title:slug,body:'Testabsatz.'});status(created,201);
    targets.push((await admin.get('/admin/pages/'+created.body.id)).body);
  }
  const [a,b]=targets;
  const links=targets.map(t=>({page_id:t.id,label:'Link '+t.slug,visible:true}));
  for(const bad of [[links[0],links[0]],[{...links[0],page_id:uuidv7()}],[{...links[0],visible:'yes'}],Array(13).fill(links[0])]) status(await write('header',h,bad),422);
  status(await write('header',h,[{...links[0],href:'https://example.invalid'}]),400);
  const saves=await Promise.all([write('header',h,links),write('header',h,links)]);assert.deepEqual(saves.map(r=>r.status).sort(),[200,409]);
  status(await write('footer',f,[links[0]]),200);assert.deepEqual(await pub(),{header:[],footer:[]});
  for(const t of targets)status(await admin.change('post',`/admin/pages/${t.id}/publish`,{revision:t.revision,version_id:t.latest.id}),200);
  const visible=targets.map((t,i)=>({href:'/seiten/'+t.slug,label:links[i].label}));
  assert.deepEqual(await pub(),{header:visible,footer:visible.slice(0,1)});
  status(await write('header',h+1,[links[1],links[0]]),200);assert.deepEqual((await pub()).header,[visible[1],visible[0]]);
  status(await write('header',h+2,[links[1],{...links[0],visible:false}]),200);
  status(await admin.change('post',`/admin/pages/${b.id}/withdraw`,{revision:b.revision+1,version_id:b.latest.id}),200);
  assert.deepEqual(await pub(),{header:[],footer:[visible[0]]});
  assert.equal((await read('header')).items[0].published,false);
  status(await write('footer',f+1,[]),200);assert.deepEqual((await pub()).footer,[]);
  const audit=await db.auditEvent.findFirstOrThrow({where:{action:'navigation.updated',target_ref:'header'},orderBy:{id:'desc'}});
  assert.deepEqual(audit.after_safe,{count:2,revision:h+3});
});

test('legal editor versions without exposing payment settings or creating checkout consents',async()=>{
  const path='/admin/commerce/legal', kind='payment_info', view='/admin/legal-documents/'+kind;
  const viewer=new Browser(), form={kind,base_id:null,wording:'Synthetische Zahlungsinformation'};
  status(await viewer.get(view),401);status(await participant.change('post',path,form),403);
  status(await admin.change('post',path,form,{noCsrf:true}),403);
  const writes=await Promise.all([admin.change('post',path,form),admin.change('post',path,form)]);
  assert.deepEqual(writes.map(r=>r.status).sort(),[201,409]);const first=writes.find(r=>r.status===201).body;
  const detail=await admin.get(view);status(detail,200);assert.deepEqual(Object.keys(detail.body).sort(),['active_version','versions']);
  assert.equal((await viewer.get('/shop/config')).body.legal[kind],undefined);
  const activate=id=>admin.change('post',path+'/'+id+'/activate',{});
  status(await activate(first.id),200);
  const second=await admin.change('post',path,{...form,base_id:first.id,wording:'Zweite Testfassung'});status(second,201);
  const third=await admin.change('post',path,{...form,base_id:second.body.id,wording:'Dritte Testfassung'});status(third,201);
  status(await activate(second.body.id),409);assert.equal((await viewer.get('/shop/config')).body.legal[kind].id,first.id);
  status(await activate(third.body.id),200);assert.equal((await viewer.get('/shop/config')).body.legal[kind].id,third.body.id);
  const archived=(await admin.get(view)).body.versions.find(v=>v.id===first.id);assert.equal(archived.status,'retired');assert.equal(archived.wording,form.wording);
});

test('dashboard scopes are derived from roles and current course assignments, not query parameters', async () => {
  const path='/admin/dashboard';status(await new Browser().get(path),401);status(await participant.get(path),403);
  assert.deepEqual((await support.get(path)).body,{scope:'basic',public_courses:0});
  assert.deepEqual((await admin.get(path)).body,{scope:'global',courses:2,completions:0});
  assert.deepEqual((await instructor.get(path)).body,{scope:'assigned',courses:0,completions:0});
  status(await manager.get(path+'?scope=global'),400);
  const finance=path+'/finance';status(await new Browser().get(finance),401);
  for(const viewer of [support,manager,instructor,participant]) status(await viewer.get(finance+'?period=all'),403);
  status(await admin.get(finance+'?period=last_hour'),422);status(await admin.get(finance+'?environment=live'),400);
  const empty=await admin.get(finance);status(empty,200);assert.equal(empty.body.payments_cents,'0');assert.equal(empty.body.fees_cents,null);
  const scoped=await db.courseStaff.create({data:{course_id:courseB.id,user_id:managerUser.id,assigned_by:adminUser.id,scope_role:'manager'}});
  try {assert.deepEqual((await manager.get(path)).body,{scope:'assigned',courses:1,completions:0});}
  finally {await db.courseStaff.deleteMany({where:{course_id:scoped.course_id,user_id:managerUser.id}});}
  assert.deepEqual((await manager.get(path)).body,{scope:'assigned',courses:0,completions:0});
});

test('mail workspace denies callers without the specific backoffice permissions', async () => {
  const template='/admin/certificate-mail-template', jobs='/admin/automation-jobs';
  for (const area of [template,jobs]) {
    status(await new Browser().get(area),401);
    for(const viewer of [participant,support,manager,instructor]) status(await viewer.get(area),403);
  }
  status(await support.change('post',template+'/drafts',{}),403);
  status(await support.change('post',jobs+'/'+uuidv7()+'/retry',{}),403);
});

test('audit reader requires MFA and audit.read; bounded pages omit free text and private payloads', async () => {
  const endpoint = '/admin/audit-events', filtered = endpoint+'?scope=certificates';
  status(await new Browser().get(endpoint),401);
  for (const viewer of [participant, manager, instructor, support]) status(await viewer.get(endpoint),403);
  status(await admin.get(endpoint+'?scope=invalid'),422);
  status(await admin.get(endpoint+'?before=invalid'),404);
  status(await admin.get(endpoint+'?include=after_safe'),400);
  const ref = uuidv7();
  const rows = Array.from({length:26}, (_,i) => ({ id:uuidv7(), action:'certificate.issued', origin:'system',
    target_type:'certificate', target_ref:i === 25 ? 'private@example.invalid' : ref,
    after_safe:{ note:'private note' }, reason_code:'private_reason' }));
  await db.auditEvent.createMany({data:rows});
  const first = await admin.get(filtered); status(first,200);
  assert.equal(first.body.data.length,25);
  assert.equal(first.body.next_cursor, first.body.data.at(-1).id);
  const top = first.body.data[0];
  assert.equal(top.id,rows[25].id); assert.equal(top.target_id,null);
  assert.deepEqual(Object.keys(top).sort(),['action','created_at','id','origin','target_id','target_type']);
  assert.equal(first.body.data[1].target_id,ref);
  assert.doesNotMatch(JSON.stringify(first.body),/private@example|private note|private_reason/);
  const second = await admin.get(filtered+'&before='+first.body.next_cursor); status(second,200);
  assert.deepEqual(second.body.data.map(x=>x.id),[rows[0].id]); assert.equal(second.body.next_cursor,null);
  // Existing course/user events are present without the certificate filter.
  const general = await admin.get(endpoint+'?before='+rows[0].id); status(general,200);
  assert.ok(general.body.data.some(x => x.target_type !== 'certificate'));
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


test('chapter editors save incomplete questions; only freshly confirmed publishers can approve a complete revision', async () => {
  const course = await createCourse('fragenredaktion');
  const module = await admin.change('post', `/admin/course-versions/${course.version_id}/modules`, { title: 'Testmodul', position: 1 }); status(module, 201);
  const chapter = await admin.change('post', `/admin/course-modules/${module.body.id}/chapters`, { title: 'Testkapitel', position: 1 }); status(chapter, 201);
  const base = `/admin/course-chapters/${chapter.body.id}/exams`;
  status(await instructor.get(base), 404); status(await participant.get(base), 403);
  status(await assign(course.id, instructorUser.id, 'instructor'), 200);
  status(await instructor.change('post', base, { title: 'Testprüfung' }, { noCsrf: true }), 403);
  const exam = await instructor.change('post', base, { title: 'Testprüfung' }); status(exam, 201);
  const list = `${base}/${exam.body.id}/questions`;
  const initial = { question_text: 'Synthetische Frage?', explanation: '', options: [] };
  const saved = await instructor.change('post', list, initial); status(saved, 201);
  const path = `${list}/${saved.body.id}`, approve = revision => admin.change('post', `${path}/approve`, { revision });
  status(await participant.get(list), 403);
  status(await instructor.change('post', `${path}/approve`, { revision: 1 }), 403);
  await db.authSession.updateMany({ where: { user_id: adminUser.id, kind: 'backoffice' }, data: { reauthenticated_at: null } });
  const notFresh = await approve(1); status(notFresh, 403); assert.equal(notFresh.body.code, 'REAUTH_REQUIRED');
  status(await admin.change('post', '/auth/reauth', { password, recovery_code: adminRecovery[4] }), 204);
  const options = [1,2,3,4].map(n => ({ option_text: `Testantwort ${n}`, is_correct: n === 2 }));
  const complete = { ...initial, options, explanation: 'Synthetische Lösungserklärung.' };
  let rev = 1;
  for (const incomplete of [{ ...complete, options: options.slice(0, 3) }, { ...complete, explanation: '' },
    { ...complete, options: options.map(o => ({ ...o, is_correct: false })) }]) {
    status(await instructor.change('put', path, { ...incomplete, revision: rev++ }), 200);
    const blocked = await approve(rev); status(blocked, 422); assert.equal(blocked.body.code, 'QUESTION_INCOMPLETE');
  }
  status(await instructor.change('put', path, { ...complete, revision: rev, options: options.map(o => ({ ...o, is_correct: true })) }), 422);
  status(await instructor.change('put', path, { ...complete, revision: rev, status: 'active' }), 400);
  status(await instructor.change('put', path, { ...complete, revision: rev - 1 }), 409);
  status(await instructor.change('put', path, { ...complete, revision: rev++ }), 200);
  status(await approve(rev - 1), 409);
  status(await admin.change('post', `${path}/approve`, { revision: rev }, { noCsrf: true }), 403);
  const release = await approve(rev); status(release, 200); assert.equal(release.body.status, 'active');
  status(await approve(rev + 1), 409);
  status(await instructor.change('put', path, { ...initial, revision: rev + 1 }), 409);
  const read = await instructor.get(list); status(read, 200); assert.deepEqual(read.body[0].options, options);
  assert.equal(read.body[0].explanation, complete.explanation); assert.equal(read.body[0].revision, rev + 1);
  const other = await instructor.change('post', base, { title: 'Anderer Pool' }); status(other, 201);
  status(await instructor.change('put', path.replace(exam.body.id, other.body.id), { ...initial, revision: rev + 1 }), 404);
  const readiness = await admin.get(`/admin/courses/${course.id}/publication`); status(readiness, 200);
  assert.ok(readiness.body.readiness.some(r => r.code === 'EXAM_POOL_INCOMPLETE'));
  const events = await db.auditEvent.findMany({ where: { target_ref: course.id, action: { startsWith: 'exam.' } } });
  assert.equal(events.filter(e => e.action === 'exam.question_approved').length, 1);
  assert.ok(!JSON.stringify(events).includes(complete.explanation));
});

test('course uploads are bounded, scoped, and end in a separate private quarantine bucket', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOxSaxkAAAAASUVORK5CYII=', 'base64');
  const post = async (browser, id, bytes, name = 'Beispiel.png', csrf = true) => {
    const req = request(server).post(`/api/v1/admin/courses/${id}/media/uploads`).set('Origin', origin)
      .set('Content-Type', 'application/octet-stream').set('X-Upload-Name', encodeURIComponent(name));
    if (csrf) req.set('X-CSRF-Token', (await browser.get('/auth/csrf')).body.csrf_token);
    return req.set('Cookie', browser.cookie()).send(bytes);
  };
  const cfg = require('../../apps/api/dist/config').getConfig();
  const before = await db.courseMediaUpload.count(), assets = await db.mediaAsset.count();
  status(await post(participant, courseB.id, png), 403);
  status(await post(instructor, courseA.id, png), 404);
  status(await post(instructor, courseB.id, png, 'x.png', false), 403);
  status(await post(instructor, courseB.id, png), 503); // disabled by default
  // Only the disposable gateway uses a synthetic root identity for provisioning.
  cfg.quarantineStore = { ...cfg.mediaStore, bucket: 'trainerb-quarantine' };
  try {
    status(await post(instructor, courseB.id, Buffer.from('not an image')), 422);
    status(await post(instructor, courseB.id, png, '../x.png'), 422);
    status(await post(instructor, courseB.id, png, 'x.pdf'), 422);
    status(await post(instructor, courseB.id, Buffer.alloc(5 * 1024 * 1024 + 1)), 413);
    assert.equal(await db.courseMediaUpload.count(), before);
    if (!process.env.TRAINERB_TEST_S3_ORIGIN) return;
    const { AwsClient } = require('aws4fetch');
    const client = new AwsClient({ ...cfg.mediaStore, service: 's3', retries: 0 });
    const bucket = `${cfg.mediaStore.origin}/${cfg.quarantineStore.bucket}`;
    status(await post(instructor, courseB.id, png), 503); // nonexistent bucket: no receipt
    assert.equal(await db.courseMediaUpload.count(), before);
    assert.equal((await client.fetch(bucket, { method: 'PUT' })).status, 200);
    const response = await post(instructor, courseB.id, png);
    status(response, 201); assert.deepEqual(Object.keys(response.body).sort(), ['id','status']);
    assert.equal(response.body.status, 'pending_scan');
    const row = await db.courseMediaUpload.findUniqueOrThrow({ where: { id: response.body.id } });
    assert.equal(row.course_id, courseB.id); assert.equal(row.uploaded_by, instructorUser.id);
    assert.equal(row.size_bytes, png.length); assert.equal(row.mime_detected, 'image/png');
    assert.deepEqual(Buffer.from(row.sha256), require('node:crypto').createHash('sha256').update(png).digest());
    const url = `${bucket}/${row.object_key}`;
    assert.equal((await fetch(url)).status, 403);
    assert.deepEqual(Buffer.from(await (await client.fetch(url)).arrayBuffer()), png);
    assert.equal(await db.mediaAsset.count(), assets);
    assert.equal(await db.auditEvent.count({ where: { target_ref: courseB.id, action: 'media.upload_quarantined' } }), 1);
    const { scanNext, inspectUpload } = require('../../apps/api/dist/media-scan');
    const missingSocket = '/tmp/trainerb-clamd-unconfigured.sock';
    const inspect = receipt => inspectUpload(receipt, cfg.quarantineStore, missingSocket);
    // Exercise the deployed entry point, not just its helpers. No API env, session
    // keys, upload credentials or Redis. Only this disposable S3 uses a test root.
    const cli = require('node:child_process').spawnSync(process.execPath, [require.resolve('../../apps/api/dist/cli/media-scan')], {
      cwd: require('node:os').tmpdir(), timeout: 40000, encoding: 'utf8', env: {
        DATABASE_URL: process.env.DATABASE_URL, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        MEDIA_S3_ENDPOINT: cfg.mediaStore.origin, MEDIA_S3_REGION: cfg.mediaStore.region,
        MEDIA_QUARANTINE_BUCKET: cfg.quarantineStore.bucket, MEDIA_SCAN_ACCESS_KEY_ID: cfg.mediaStore.accessKeyId,
        MEDIA_SCAN_SECRET_ACCESS_KEY: cfg.mediaStore.secretAccessKey, MEDIA_SCAN_CLAMD_SOCKET: missingSocket,
      },
    });
    assert.equal(cli.status, 1, cli.stderr);
    const { event, ...failed } = JSON.parse(cli.stdout.trim()); assert.equal(event, 'media.scanned');
    assert.deepEqual(failed, { id: row.id, status: 'scan_error', scan_error: 'scanner' });
    assert.equal(await scanNext(db, inspect), null); // errors do not starve the queue
    // Same length, different bytes: the object cannot receive a scanner verdict.
    assert.equal((await client.fetch(url, { method: 'PUT', body: Buffer.alloc(png.length) })).status, 200);
    assert.equal((await scanNext(db, inspect, row.id)).scan_error, 'integrity');
    assert.equal((await client.fetch(url, { method: 'DELETE' })).status, 204);
    assert.equal((await scanNext(db, inspect, row.id)).scan_error, 'storage');
    const detail = await instructor.get(`/admin/courses/${courseB.id}`); status(detail, 200);
    const report = detail.body.quarantine_uploads.find(upload => upload.id === row.id);
    assert.equal(report.status, 'scan_error'); assert.equal(report.scan_error, 'storage'); assert.ok(report.scanned_at);
    assert.deepEqual(Object.keys(report).sort(), ['approved_at','id','original_name','promoted_asset_id','promotion_error','scan_error','scanned_at','status']);
    status(await participant.get(`/admin/courses/${courseB.id}`), 403);
    // An explicit retry is serialized; terminal verdicts cannot be retried.
    const results = await Promise.all([1, 2].map(() => scanNext(db, async () => ({ status: 'infected', scan_error: null }), row.id)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await scanNext(db, inspect, row.id), null);
    assert.equal(await db.auditEvent.count({ where: { action: 'media.scanned', target_ref: row.id } }), 4);
    assert.equal(await db.mediaAsset.count(), assets);

  } finally { cfg.quarantineStore = undefined; }
});

test('editorial approval is separate from scanning, course-bound and recorded exactly once', async () => {
  const assets = await db.mediaAsset.count();
  const receipt = await db.courseMediaUpload.create({ data: { id: uuidv7(), course_id: courseB.id, uploaded_by: instructorUser.id,
    object_key: randomUUID(), original_name: 'Test.png', mime_detected: 'image/png', size_bytes: 1,
    sha256: require('node:crypto').createHash('sha256').update('A').digest() } });
  const path = `/admin/courses/${courseB.id}/media/uploads/${receipt.id}/approve`;
  status(await instructor.change('post', path, {}), 403);
  await db.authSession.updateMany({ where: { user_id: adminUser.id, kind: 'backoffice' }, data: { reauthenticated_at: null } });
  const stale = await admin.change('post', path, {}); status(stale, 403); assert.equal(stale.body.code, 'REAUTH_REQUIRED');
  status(await admin.change('post', '/auth/reauth', { password, recovery_code: adminRecovery[1] }), 204);
  status(await admin.change('post', path, {}, { noCsrf: true }), 403);
  status(await admin.change('post', path.replace(courseB.id, courseA.id), {}), 404);
  status(await admin.change('post', path, { status: 'clean' }), 400);
  status(await admin.change('post', path, {}), 409);
  await assert.rejects(db.courseMediaUpload.update({ where: { id: receipt.id }, data: { approved_by: adminUser.id, approved_at: new Date() } }), /upload_approval_clean/);
  for (const verdict of ['infected', 'scan_error', 'clean']) {
    await db.courseMediaUpload.update({ where: { id: receipt.id }, data: { status: verdict, scanned_at: new Date(), scan_error: verdict === 'scan_error' ? 'scanner' : null } });
    if (verdict !== 'clean') status(await admin.change('post', path, {}), 409);
  }
  const { promoteNext } = require('../../apps/api/dist/media-promote');
  const store = require('../../apps/api/dist/config').getConfig().mediaStore;
  const stores = { source: { ...store, bucket: 'trainerb-quarantine' }, destination: { ...store, bucket: 'promotion-destination' } };
  assert.equal(await promoteNext(db, stores), null); // even clean is not sufficient
  const responses = await Promise.all([admin.change('post', path, {}), admin.change('post', path, {})]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const saved = await db.courseMediaUpload.findUniqueOrThrow({ where: { id: receipt.id } });
  assert.equal(saved.approved_by, adminUser.id); assert.ok(saved.approved_at); assert.equal(saved.status, 'clean');
  const details = await instructor.get(`/admin/courses/${courseB.id}`); status(details, 200);
  assert.equal(details.body.quarantine_uploads.find(r => r.id === receipt.id).approved_at, saved.approved_at.toISOString());
  assert.equal(await db.auditEvent.count({ where: { action: 'media.upload_approved', actor_user_id: adminUser.id, target_ref: courseB.id } }), 1);
  assert.equal(await db.mediaAsset.count(), assets);
  if (!process.env.TRAINERB_TEST_S3_ORIGIN) return;
  const { AwsClient } = require('aws4fetch');
  const client = new AwsClient({ ...store, service: 's3', retries: 0 });
  const src = `${store.origin}/${stores.source.bucket}/${receipt.object_key}`, dest = `${store.origin}/${stores.destination.bucket}`;
  assert.equal((await promoteNext(db, stores)).error, 'storage'); // missing source
  assert.equal(await promoteNext(db, stores), null); // no automatic retry loop
  assert.equal((await client.fetch(src, { method: 'PUT', body: 'B' })).status, 200);
  assert.equal((await promoteNext(db, stores, receipt.id)).error, 'integrity'); // same size, changed hash
  assert.equal((await client.fetch(src, { method: 'PUT', body: 'A' })).status, 200);
  assert.equal((await promoteNext(db, stores, receipt.id)).error, 'destination'); // missing destination
  assert.equal(await db.mediaAsset.count(), assets);
  assert.equal((await client.fetch(dest, { method: 'PUT' })).status, 200);
  const promoted = (await Promise.all([1,2].map(() => promoteNext(db, stores, receipt.id)))).filter(Boolean);
  assert.equal(promoted.length, 1); assert.equal(promoted[0].error, null);
  const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: promoted[0].asset_id } });
  assert.equal(asset.status, 'ready'); assert.equal(asset.visibility, 'private'); assert.equal(asset.uploaded_by, receipt.uploaded_by);
  assert.equal(asset.original_name, receipt.original_name); assert.deepEqual(asset.sha256, receipt.sha256);
  assert.notEqual(asset.storage_key, receipt.object_key);
  const target = `${dest}/${asset.storage_key}`; assert.equal((await fetch(target)).status, 403);
  assert.equal(await (await client.fetch(target)).text(), 'A');
  assert.equal((await db.courseMediaUpload.findUniqueOrThrow({ where: { id: receipt.id } })).promoted_asset_id, asset.id);
  assert.equal(await db.auditEvent.count({ where: { action: 'media.promoted', target_ref: receipt.id } }), 1);
  assert.equal(await promoteNext(db, stores), null); assert.equal(await promoteNext(db, stores, receipt.id), null);

});

test('draft editor lists and assigns only approved, promoted private media of the chapter course', async () => {
  const course = await createCourse('kapitelmedien');
  const mod = await admin.change('post', `/admin/course-versions/${course.version_id}/modules`, { title: 'Modul', position: 1 }); status(mod, 201);
  const chapter = await admin.change('post', `/admin/course-modules/${mod.body.id}/chapters`, { title: 'Entwurf', position: 1 }); status(chapter, 201);
  const base = `/admin/course-chapters/${chapter.body.id}`;
  async function fixture(courseId, mime, promoted = true) {
    const asset = await db.mediaAsset.create({ data: { id: uuidv7(), source: 's3', storage_key: randomUUID(), mime_detected: mime,
      original_name: mime === 'image/png' ? 'Bild.png' : 'Dokument.pdf', size_bytes: 22, status: 'ready', visibility: 'private' } });
    if (promoted) await db.courseMediaUpload.create({ data: { id: uuidv7(), course_id: courseId, uploaded_by: adminUser.id, object_key: randomUUID(),
      size_bytes: 22, sha256: Buffer.alloc(32), mime_detected: mime, original_name: asset.original_name, approved_at: new Date(), approved_by: adminUser.id,
      scanned_at: new Date(), status: 'clean', promoted_asset_id: asset.id } });
    return asset;
  }
  const image = await fixture(course.id, 'image/png'), pdf = await fixture(course.id, 'application/pdf');
  const foreign = await fixture(courseB.id, 'image/png'), legacy = await fixture(course.id, 'image/png', false);
  const add = (id, options) => admin.change('post', `${base}/contents`, { media_asset_id: id }, options);
  status(await instructor.get(`${base}/media-options`), 404);
  const options = await admin.get(`${base}/media-options`); status(options, 200);
  assert.deepEqual(options.body.data, [ { id: image.id, original_name: image.original_name, kind: 'image' },
    { id: pdf.id, original_name: pdf.original_name, kind: 'file' } ]);
  assert.deepEqual((await admin.get(`${base}/media-options?cursor=${image.id}`)).body.data.map(r => r.id), [pdf.id]);
  status(await instructor.change('post', `${base}/contents`, { media_asset_id: image.id }), 404);
  status(await add(image.id, { noCsrf: true }), 403);
  status(await add(foreign.id), 409); status(await add(legacy.id), 409);
  const attached = await add(image.id); status(attached, 201); assert.equal(attached.body.kind, 'image'); assert.equal(attached.body.body, null);
  const file = await add(pdf.id); status(file, 201); assert.equal(file.body.kind, 'file'); assert.equal(file.body.title, pdf.original_name);
  assert.equal(file.body.position, attached.body.position + 1);
  await db.mediaAsset.update({ where: { id: image.id }, data: { status: 'quarantined' } });
  status(await add(image.id), 409); // was eligible when picker opened
  assert.deepEqual((await admin.get(`${base}/media-options`)).body.data.map(r => r.id), [pdf.id]);
  const remove = rev => admin.change('delete', `/admin/chapter-contents/${attached.body.id}`, { revision: rev });
  status(await remove(2), 409); status(await remove(1), 204); // remove broken reference, not the asset
  assert.equal((await db.mediaAsset.findUniqueOrThrow({ where: { id: image.id } })).status, 'quarantined');
  assert.equal((await db.courseVersion.findUniqueOrThrow({ where: { id: course.version_id } })).state, 'draft');
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
  const storageTest = !!process.env.TRAINERB_TEST_S3_ORIGIN;
  const fixtureBytes = Buffer.from('private trainerb integration fixture');
  if (storageTest) {
    const { AwsClient } = require('aws4fetch');
    const { mediaStore } = require('../../apps/api/dist/config').getConfig();
    const seed = new AwsClient({ ...mediaStore, service: 's3', retries: 0 });
    const bucket = `${mediaStore.origin}/${mediaStore.bucket}`;
    assert.equal((await seed.fetch(bucket, { method: 'PUT' })).status, 200);
    assert.equal((await seed.fetch(`${bucket}/${lesson.storage_key}`, { method: 'PUT', body: fixtureBytes })).status, 200);
  }
  const setCover = id => db.courseVersion.update({ where: { id: course.version_id }, data: { cover_media_id: id } });
  await assert.rejects(setCover(lesson.id), /COURSE_MEDIA_UNAVAILABLE/); await setCover(cover.id);
  const mediaRow = { id: uuidv7(), course_version_id: course.version_id, chapter_id: chapterResponse.body.id,
    kind: 'image', title: 'Lernbild', position: 77, media_asset_id: lesson.id };
  await assert.rejects(db.chapterContent.create({ data: { ...mediaRow, kind: 'video' } }), /COURSE_MEDIA_UNAVAILABLE/);
  await assert.rejects(db.chapterContent.create({ data: { ...mediaRow, media_asset_id: cover.id } }), /COURSE_MEDIA_UNAVAILABLE/);
  await db.chapterContent.create({ data: mediaRow });
  const cfg = require('../../apps/api/dist/config').getConfig(), store = cfg.mediaStore;
  try {
    cfg.mediaStore = undefined;
    assert.ok((await releaseAdmin.get(`/admin/courses/${course.id}/publication`)).body.readiness
      .some(reason => reason.code === 'MEDIA_STORAGE_UNAVAILABLE'));
  } finally { cfg.mediaStore = store; }
  await db.mediaAsset.update({ where: { id: lesson.id }, data: { status: 'quarantined' } });
  const notReady = await releaseAdmin.change('post', `/admin/courses/${course.id}/publish`, { version_id: course.version_id, revision: 2 });
  status(notReady, 409); assert.ok(notReady.body.details.CHAPTER_MEDIA_UNAVAILABLE);
  await db.mediaAsset.update({ where: { id: lesson.id }, data: { status: 'ready' } });
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
  const chapterPath = `/me/courses/release-ready/chapters/${chapterResponse.body.id}`;
  const mediaPath = `${chapterPath}/media/${mediaRow.id}`;
  status(await new Browser().get(mediaPath), 401);
  status(await participant.get(mediaPath), 404);
  const access = await db.courseAccess.create({ data: { id: uuidv7(), user_id: (await contextFor(participant)).user.id,
    course_id: course.id, course_version_id: course.version_id, source: 'manual', granted_by: releaseAdminUser.id,
    starts_at: new Date(Date.now() - 60_000), ends_at: new Date(Date.now() + (storageTest ? 10_000 : 40_000)) } });
  const chapterView = await participant.get(chapterPath); status(chapterView, 200);
  assert.equal(chapterView.body.contents.find(c => c.id === mediaRow.id).media_available, true);
  assert.ok(!JSON.stringify(chapterView.body).includes(lesson.storage_key));
  const link = await participant.get(mediaPath); status(link, 302); assert.equal(link.headers['cache-control'], 'no-store');
  const signed = new URL(link.headers.location);
  assert.equal(signed.origin, store.origin); assert.equal(signed.pathname, `/${store.bucket}/${lesson.storage_key}`);
  assert.match(signed.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  assert.ok(Number(signed.searchParams.get('X-Amz-Expires')) > 0 && Number(signed.searchParams.get('X-Amz-Expires')) <= 40);
  // Use anonymous HTTP requests to the storage service, never app cookies.
  // Compare only statuses/bytes; signed URLs must not appear in test output.
  const objectGet = url => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (storageTest) {
    assert.equal((await objectGet(signed.origin + signed.pathname)).status, 403);
    const object = await objectGet(signed);
    assert.equal(object.status, 200);
    assert.deepEqual(Buffer.from(await object.arrayBuffer()), fixtureBytes);
    assert.match(object.headers.get('cache-control'), /\bno-store\b/);
    assert.equal(object.headers.get('content-type'), 'image/jpeg');
    assert.equal(object.headers.get('content-disposition'), 'inline');
  }
  status(await participant.get(mediaPath.replace(chapterResponse.body.id, uuidv7())), 404);
  status(await participant.get(`${chapterPath}/media/${lesson.id}`), 404); // an asset ID is not an authorization
  await db.courseAccess.update({ where: { id: access.id }, data: { suspended_at: new Date(), suspend_reason: 'review' } });
  const suspended = await participant.get(mediaPath); status(suspended, 403); assert.equal(suspended.body.code, 'ACCESS_SUSPENDED');
  await db.courseAccess.update({ where: { id: access.id }, data: { suspended_at: null, suspend_reason: null,
    ends_at: new Date(Date.now() - 1000) } });
  status(await participant.get(mediaPath), 403);
  await db.courseAccess.update({ where: { id: access.id }, data: { ends_at: null } });
  await db.mediaAsset.update({ where: { id: lesson.id }, data: { status: 'quarantined' } });
  const denied = await participant.get(mediaPath); status(denied, 404); assert.equal(denied.headers.location, undefined);
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
  status(await participant.get(`/me/courses/release-ready/chapters/${copiedMedia.chapter_id}/media/${copiedMedia.id}`), 404);
  assert.equal(copiedMedia.media_asset_id, lesson.id); assert.notEqual(copiedMedia.id, mediaRow.id);
  assert.equal(copiedMedia.body, null); assert.equal(copiedMedia.position, mediaRow.position);
  if (storageTest) {
    // Reuse the exact URL, without re-signing. The grant is now valid again,
    // so a fresh GET must work even though the original signature has expired.
    await new Promise(resolve => setTimeout(resolve, (Number(signed.searchParams.get('X-Amz-Expires')) + 1) * 1000));
    assert.equal((await objectGet(signed)).status, 403);
    const renewed = await participant.get(mediaPath); status(renewed, 302);
    assert.equal((await objectGet(renewed.headers.location)).status, 200);
  }
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

test('one private upload reaches only the authorized learner via scan, approval, promotion and publication',
  { skip: !process.env.TRAINERB_TEST_S3_ORIGIN && 'requires the isolated HTTPS gateway', timeout: 120000 }, async () => {
    const { withTestClamd } = require('../scanner/test-clamd.cjs');
    const { AwsClient } = require('aws4fetch');
    const cfg = require('../../apps/api/dist/config').getConfig();
    const previous = { mediaStore: cfg.mediaStore, quarantineStore: cfg.quarantineStore };
    const delivery = { ...cfg.mediaStore, bucket: 'workflow-delivery' }, quarantine = { ...delivery, bucket: 'workflow-quarantine' };
    const slug = 'medienablauf', course = await createCourse(slug, { visibility: 'public' });
    const mod = await admin.change('post', `/admin/course-versions/${course.version_id}/modules`, { title: 'Modul', position: 1 }); status(mod, 201);
    const chapter = await admin.change('post', `/admin/course-modules/${mod.body.id}/chapters`, { title: 'Kapitel', position: 1 }); status(chapter, 201);
    const base = `/admin/course-chapters/${chapter.body.id}`, uploads = `/admin/courses/${course.id}/media/uploads`;
    const version = await admin.change('patch', `/admin/course-versions/${course.version_id}`, { revision: 1, subtitle: 'Medientest', duration_minutes: 10 });
    status(version, 200);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOxSaxkAAAAASUVORK5CYII=', 'base64');
    // Only the loopback gateway has this disposable root identity. Exercise each built CLI
    // in a child process without API secrets or inherited operator storage configuration.
    function worker(name, extra) {
      const stdout = execFileSync(process.execPath, [require.resolve(`../../apps/api/dist/cli/media-${name}`)], {
        cwd: require('node:os').tmpdir(), timeout: 40000, encoding: 'utf8', env: {
          DATABASE_URL: process.env.DATABASE_URL, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
          MEDIA_S3_ENDPOINT: delivery.origin, MEDIA_S3_REGION: delivery.region, MEDIA_QUARANTINE_BUCKET: quarantine.bucket, ...extra,
        },
      });
      return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    }
    try {
      Object.assign(cfg, { mediaStore: delivery, quarantineStore: quarantine });
      const seed = new AwsClient({ ...delivery, service: 's3', retries: 0 });
      for (const store of [quarantine, delivery]) assert.equal((await seed.fetch(`${store.origin}/${store.bucket}`, { method: 'PUT' })).status, 200);
      const csrf = await admin.get('/auth/csrf'); status(csrf, 200);
      const uploaded = await request(server).post(`/api/v1${uploads}`).set('Origin', origin).set('Cookie', admin.cookie())
        .set('X-CSRF-Token', csrf.body.csrf_token).set('Content-Type', 'application/octet-stream').set('X-Upload-Name', 'Lehrbild.png').send(png);
      status(uploaded, 201); assert.equal(uploaded.body.status, 'pending_scan');
      const receipt = uploaded.body.id;
      await withTestClamd(async ({ socket }) => {
        const results = worker('scan', { MEDIA_SCAN_ACCESS_KEY_ID: delivery.accessKeyId, MEDIA_SCAN_SECRET_ACCESS_KEY: delivery.secretAccessKey,
          MEDIA_SCAN_CLAMD_SOCKET: socket });
        assert.equal(results.find(r => r.id === receipt)?.status, 'clean');
      });
      const promote = () => worker('promote', { MEDIA_S3_BUCKET: delivery.bucket, MEDIA_PROMOTE_ACCESS_KEY_ID: delivery.accessKeyId,
        MEDIA_PROMOTE_SECRET_ACCESS_KEY: delivery.secretAccessKey });
      assert.ok(!promote().some(r => r.upload_id === receipt)); // a clean verdict is not approval
      status(await admin.change('post', '/auth/reauth', { password, recovery_code: adminRecovery[2] }), 204);
      status(await admin.change('post', `${uploads}/${receipt}/approve`, {}), 200);
      const promoted = promote().find(r => r.upload_id === receipt); assert.ok(promoted?.asset_id); assert.equal(promoted.error, null);
      const choices = await admin.get(`${base}/media-options`); status(choices, 200);
      assert.deepEqual(choices.body.data.map(r => r.id), [promoted.asset_id]);
      const content = await admin.change('post', `${base}/contents`, { media_asset_id: promoted.asset_id }); status(content, 201);
      status(await admin.change('post', `/admin/courses/${course.id}/publish`, { version_id: course.version_id, revision: version.body.revision }), 200);
      const denied = await register('medien-ohne-zugang'); status(await login(denied.browser, denied.email), 200);
      const grant = await admin.change('post', '/admin/accesses', { course_id: course.id, user_id: (await contextFor(participant)).user.id,
        access_days: 1, reason: 'goodwill' }); status(grant, 201);
      const path = `/me/courses/${slug}/chapters/${chapter.body.id}`, media = `${path}/media/${content.body.id}`;
      status(await denied.browser.get(path), 404);
      const forbidden = await denied.browser.get(media); status(forbidden, 404); assert.equal(forbidden.headers.location, undefined);
      const view = await participant.get(path); status(view, 200); assert.equal(view.body.contents.find(c => c.id === content.body.id)?.media_available, true);
      const link = await participant.get(media); status(link, 302);
      const url = new URL(link.headers.location); assert.equal(url.origin, delivery.origin); assert.ok(url.pathname.startsWith(`/${delivery.bucket}/`));
      const get = address => fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      assert.equal((await get(url.origin + url.pathname)).status, 403);
      const object = await get(url); assert.equal(object.status, 200); assert.deepEqual(Buffer.from(await object.arrayBuffer()), png);
    } finally { Object.assign(cfg, previous); }
  });

test('phase 6 storage binds pools, attempts and selected options to the same chapter exam and access version', async () => {
  const course = await createCourse('pruefungsmodell', { visibility: 'public' });
  const mod = await db.courseModule.create({ data: { id: uuidv7(), course_version_id: course.version_id, title: 'Modul', position: 1 } });
  const chapter = await db.courseChapter.create({ data: { id: uuidv7(), course_version_id: course.version_id, module_id: mod.id, title: 'Kapitel', position: 1 } });
  const examData = { course_version_id: course.version_id, chapter_id: chapter.id, title: 'Synthetische Prüfung', position: 1 };
  await assert.rejects(db.exam.create({ data: { ...examData, id: uuidv7(), course_version_id: courseB.version_id } }), { code: 'P2003' });
  const exam = await db.exam.create({ data: { ...examData, id: uuidv7() } });
  const other = await db.exam.create({ data: { ...examData, id: uuidv7(), position: 2 } });
  assert.deepEqual([exam.question_count, exam.option_count, exam.pass_rule.min_correct], [3, 4, 3]);
  status(await admin.change('post', '/auth/reauth', { password, recovery_code: adminRecovery[3] }), 204);
  const readiness = await admin.get(`/admin/courses/${course.id}/publication`); status(readiness, 200);
  assert.ok(readiness.body.readiness.some(r => r.code === 'EXAM_POOL_INCOMPLETE'));
  status(await admin.change('delete', `/admin/course-chapters/${chapter.id}`, { revision: 1 }), 409);
  async function questionFor(e) {
    const pool = await db.questionPool.create({ data: { id: uuidv7(), exam_id: e.id, title: 'Testpool' } });
    return db.question.create({ data: { id: uuidv7(), pool_id: pool.id, exam_id: e.id, position: 1, question_text: 'Synthetische Frage?' } });
  }
  const q = await questionFor(exam), otherQ = await questionFor(other);
  await assert.rejects(db.question.create({ data: { id: uuidv7(), pool_id: otherQ.pool_id, exam_id: exam.id, position: 2, question_text: 'Test?' } }), { code: 'P2003' });
  const option = async (question, position) => db.answerOption.create({ data: { id: uuidv7(), question_id: question.id, position, option_text: 'Testoption', is_correct: true } });
  const correct = await option(q, 1), foreign = await option(otherQ, 1);
  await assert.rejects(option(q, 2), { code: 'P2002' });

  // Only for the persistence fixture: normal publication is deliberately still blocked.
  await db.courseVersion.update({ where: { id: course.version_id }, data: { state: 'published', published_by: adminUser.id, published_at: new Date() } });
  await db.course.update({ where: { id: course.id }, data: { status: 'published' } });
  await db.coursePublication.create({ data: { id: uuidv7(), course_id: course.id, course_version_id: course.version_id,
    version: 1, action: 'published', actor_user_id: adminUser.id } });
  const access = await db.courseAccess.create({ data: { id: uuidv7(), course_id: course.id, course_version_id: course.version_id,
    user_id: adminUser.id, source: 'manual', granted_by: adminUser.id } });
  const start = (n, key, overrides = {}) => db.examAttempt.create({ data: { id: uuidv7(), access_id: access.id,
    course_version_id: course.version_id, exam_id: exam.id, attempt_no: n, start_idempotency_key: key, ...overrides } });
  await assert.rejects(start(1, 'wrong-version', { course_version_id: courseB.version_id }), { code: 'P2003' });
  const started = await Promise.allSettled([start(1, 'one'), start(2, 'two')]);
  const winners = started.filter(s => s.status === 'fulfilled'); assert.equal(winners.length, 1);
  assert.equal(started.find(s => s.status === 'rejected').reason.code, 'P2002');
  const attempt = winners[0].value;
  const select = (question, position) => db.examAttemptQuestion.create({ data: { attempt_id: attempt.id, exam_id: exam.id, question_id: question.id, position } });
  await assert.rejects(select(otherQ, 1), { code: 'P2003' }); await select(q, 1);
  const choice = opt => db.examAttemptOption.create({ data: { attempt_id: attempt.id, question_id: q.id, option_id: opt.id, position: 1 } });
  await assert.rejects(choice(foreign), { code: 'P2003' }); await choice(correct);
  await assert.rejects(db.examAttemptOption.updateMany({ where: { attempt_id: attempt.id }, data: { position: 2 } }), /EXAM_SELECTION_IMMUTABLE/);
  await db.examAttempt.update({ where: { id: attempt.id }, data: { status: 'expired' } });
  await assert.rejects(db.examAttempt.update({ where: { id: attempt.id }, data: { status: 'in_progress' } }), /EXAM_ATTEMPT_IMMUTABLE/);
  await assert.rejects(start(3, attempt.start_idempotency_key), { code: 'P2002' });
  assert.equal((await start(3, 'retry')).status, 'in_progress');
});

test('published chapter quiz: guarded idempotent start/resume, private grading, alternative questions and progress', async () => {
  const slug = 'lernquiz', course = await createCourse(slug, { visibility: 'unlisted', chapter_completion_mode: 'all_chapter_exams' });
  const write = (method, path, data) => admin.change(method, path, data);
  const m = await write('post', `/admin/course-versions/${course.version_id}/modules`, { title: 'Quizmodul', position: 1 }); status(m,201);
  const c = await write('post', `/admin/course-modules/${m.body.id}/chapters`, { title: 'Quizkapitel', position: 1 }); status(c,201);
  const chapter = c.body.id, editor = `/admin/course-chapters/${chapter}`;
  status(await write('post', `${editor}/contents`, { block: { kind: 'paragraph', text: 'Testinhalt.' } }),201);
  const v = await write('patch', `/admin/course-versions/${course.version_id}`, { revision: 1, duration_minutes: 10, subtitle: 'Quiz' }); status(v,200);
  const exam = await write('post', `${editor}/exams`, { title: 'Testquiz' }); status(exam,201);
  status(await write('post', '/auth/reauth', { password, recovery_code: adminRecovery[5] }),204);
  const solution = new Map();
  for (let i = 0; i < 6; i++) {
    const correct = i % 4, path = `${editor}/exams/${exam.body.id}/questions`;
    const q = await write('post', path, { question_text: `Testfrage ${i}`, explanation: `Nur nach Bestehen ${i}`,
      options: [0,1,2,3].map(n => ({ option_text: `Auswahl ${n}`, is_correct: n === correct })) }); status(q,201);
    status(await write('post', `${path}/${q.body.id}/approve`, { revision: 1 }),200); solution.set(q.body.id, `Auswahl ${correct}`);
  }
  status(await write('post', `/admin/courses/${course.id}/publish`, { version_id: course.version_id, revision: v.body.revision }),200);
  const actor = await contextFor(participant), grant = await write('post', '/admin/accesses', { course_id: course.id, user_id: actor.user.id, access_days: 1, reason: 'goodwill' }); status(grant,201);
  const lesson = `/me/courses/${slug}/chapters/${chapter}`, page = await participant.get(lesson); status(page,200);
  assert.equal(page.body.can_self_complete, false); assert.deepEqual(page.body.exams, [{ id: exam.body.id, title: 'Testquiz' }]);
  status(await participant.change('post', `${lesson}/complete`, {}),409);
  const access = grant.body.id, path = `/enrollments/${access}/exams/${exam.body.id}/attempts`;
  const start = key => participant.change('post',path,{}, {key});
  const submit = (attempt, answers, key) => participant.change('post', `${path}/${attempt}/submit`, {answers}, {key});
  status(await admin.get(`${path}/current`),404); status(await new Browser().get(`${path}/current`),401);
  status(await participant.change('post',path,{}, {noCsrf:true, key:randomUUID()}),403);
  const firstKey = randomUUID(); const starts = await Promise.all([start(firstKey), start(firstKey)]);
  starts.forEach(r => status(r,200)); assert.deepEqual(starts[0].body, starts[1].body); const first = starts[0].body;
  assert.equal(first.status, 'in_progress'); assert.equal(first.questions.length,3);
  for (const q of first.questions) { assert.deepEqual(Object.keys(q).sort(), ['id','options','text']); assert.equal(q.options.length,4);
    for (const o of q.options) assert.deepEqual(Object.keys(o).sort(),['id','text']); }
  assert.deepEqual((await participant.get(`${path}/current`)).body.attempt, first);
  status(await start(randomUUID()),409);
  const choices = (attempt, correctCount) => attempt.questions.map((q,i) => ({ question_id:q.id,
    option_id:q.options.find(o => (o.text === solution.get(q.id)) === (i < correctCount)).id }));
  const picks = choices(first,2), submitKey = randomUUID();
  status(await submit(first.id, picks.slice(0,2), submitKey),422);
  status(await submit(first.id, [picks[0], picks[1], picks[1]], submitKey),422);
  status(await submit(first.id, [picks[0], picks[1], {...picks[2], option_id:picks[0].option_id}], submitKey),422);
  await db.courseAccess.update({ where:{id:access}, data:{suspended_at:new Date(), suspend_reason:'review'} });
  status(await participant.get(`${path}/current`),403); status(await submit(first.id,picks,submitKey),403);
  await db.courseAccess.update({ where:{id:access}, data:{suspended_at:null, suspend_reason:null} });
  const submissions = await Promise.all([submit(first.id,picks,submitKey),submit(first.id,picks,submitKey)]);
  submissions.forEach(r => {status(r,200); assert.deepEqual(r.body,{id:first.id,status:'failed'});});
  status(await submit(first.id,choices(first,3),submitKey),409); status(await submit(first.id,picks,randomUUID()),409);
  assert.equal((await participant.get(lesson)).body.completed_at,null);
  const retry = await start(randomUUID()); status(retry,200); const second = retry.body;
  assert.ok(second.questions.every(q => !first.questions.some(used => used.id === q.id)));
  const pass = await submit(second.id,choices(second,3),randomUUID()); status(pass,200); assert.equal(pass.body.status,'passed');
  assert.deepEqual(pass.body.solutions.map(s => s.text), second.questions.map(q => q.text));
  assert.ok(pass.body.solutions.every(s => s.explanation.startsWith('Nur nach Bestehen')));
  assert.ok((await participant.get(lesson)).body.completed_at); assert.equal(await db.examAttempt.count({where:{access_id:access}}),2);
  assert.deepEqual((await start(firstKey)).body,{id:first.id,status:'failed'}); // replay does not reveal earlier solutions
  status(await start(randomUUID()),409);
  const next = await write('post', `/admin/courses/${course.id}/versions`, {}); status(next,201);
  const copy = await db.exam.findFirstOrThrow({where:{course_version_id:next.body.version_id},include:{pool:{include:{questions:true}}}});
  assert.notEqual(copy.id,exam.body.id); assert.equal(copy.pool.questions.length,6);
  assert.ok(copy.pool.questions.every(q => q.status==='draft' && !solution.has(q.id)));
  status(await participant.get(`/enrollments/${access}/exams/${copy.id}/attempts/current`),404);
});

// Exercise the real application path from a guest payment to the specific grant that earns the PDF.
// Publication of the synthetic qualification course is a fixture; production publication is not changed.
async function buyQualification(course){
  await require('../../apps/api/dist/cli/commerce').seedCommerce(db);
  const state=(await admin.get('/admin/provider-profile')).body;
  const profile=await admin.change('patch','/admin/provider-profile',{revision:state.revision,details:{legal_provider_name:'Abnahme-Testanbieter',responsible_name:'Test Redaktion',street:'Testweg 1',postal_code:'12345',city:'Teststadt',country:'DE',contact_email:'test@example.invalid'}});status(profile,200);
  const versions={};for(const kind of ['terms','withdrawal','privacy','imprint']){
    const draft=await admin.change('post','/admin/commerce/legal',{kind,wording:`Synthetischer Testtext: ${kind}`,...(kind==='imprint'?{provider_revision:profile.body.revision}:{})});status(draft,201);
    status(await admin.change('post','/admin/commerce/legal/'+draft.body.id+'/activate',{}),200);if(kind!=='imprint')versions[kind]=draft.body.id;
  }
  const {id,updated_at,updated_by,currency,...fields}=await db.commerceSettings.findUniqueOrThrow({where:{id:1}});
  status(await admin.change('post','/admin/commerce/settings',{...fields,sales_enabled:true}),200);
  const product=await admin.change('post','/admin/products',{sku:'ABNAHME-84',type:'single',title:'Prüflauf',description:'Nur für synthetische Tests.',courses:[{course_id:course.id,access_days_override:30}]});status(product,201);
  const base='/admin/products/'+product.body.id,price=await admin.change('post',base+'/prices',{currency:'EUR',gross_cents:'24900',tax_category:'standard',valid_from:new Date(Date.now()-60000).toISOString().slice(0,16)+'Z'});status(price,201);
  const p=await db.product.findUniqueOrThrow({where:{id:product.body.id}});status(await admin.change('post',base+'/activate',{revision:p.revision}),200);
  const rate=await db.price.findUniqueOrThrow({where:{id:price.body.id}});status(await admin.change('post','/admin/prices/'+rate.id+'/activate',{revision:rate.revision}),200);
  const email='qualifikation@example.invalid',body={idempotency_key:`guest-${uuidv7()}`,participant_first_name:'Test',participant_last_name:'Person',payment_method:'stripe',
    legal_versions:versions,terms_accepted:true,withdrawal_notice_seen:true,privacy_notice_seen:true,billing_address:{first_name:'Test',last_name:'Person',street:'Testweg 1',postal_code:'12345',city:'Teststadt',country:'DE'}};
  const orderId=await require('../helpers/guest-card-purchase.cjs').exerciseGuestCard({app,db,server,Browser,product:product.body,body,email});
  const user=await db.user.findUniqueOrThrow({where:{email_canonical:email}});assert.equal(user.status,'pending_activation');
  await activate(user);participant=new Browser();status(await login(participant,email),200);
  return (await db.courseAccess.findFirstOrThrow({where:{order_id:orderId,user_id:user.id,course_version_id:course.version_id,source:'order'}})).id;
}

test('qualification completion requires 84 different passes on this access, not 84 attempts or self-confirmed chapters', async () => {
  const slug = 'abschluss-fixture', course = await createCourse(slug, {visibility:'public', expected_module_count: 14, expected_chapter_count: 42,
    expected_exams_per_chapter: 2, chapter_completion_mode: 'self_or_all_chapter_exams' });
  const version = course.version_id, profile = 'qualification_84_v1';
  status(await admin.change('patch', `/admin/course-versions/${version}`, { revision: 1, completion_profile: profile, expected_module_count: 1 }), 422);
  status(await admin.change('patch', `/admin/course-versions/${version}`, { revision: 1, completion_profile: profile }), 200);
  const templateInput = {course_version_id:version,heading:'Testurkunde',issuer:'Synthetischer Aussteller'};
  status(await participant.change('post','/admin/certificate-templates',templateInput),403);
  status(await admin.change('post','/admin/certificate-templates',templateInput,{noCsrf:true}),403);
  const template = await admin.change('post','/admin/certificate-templates',templateInput); status(template,201);
  status(await admin.change('post',`/admin/certificate-templates/${template.body.id}/approve`,{}),200);
  await assert.rejects(db.certificateTemplate.update({where:{id:template.body.id},data:{issuer:'Geändert'}}),/TEMPLATE_IMMUTABLE/);
  const modules = Array.from({ length: 14 }, (_, i) => ({ id: uuidv7(), course_version_id: version, position: i+1, title: `M${i+1}` }));
  const chapters = modules.flatMap(m => [1,2,3].map(position => ({ id: uuidv7(), course_version_id: version, module_id: m.id, position, title: `K${position}` })));
  const exams = chapters.flatMap(c => [1,2].map(position => ({ id: uuidv7(), course_version_id: version, chapter_id: c.id, position, title: `P${position}` })));
  await db.courseModule.createMany({ data: modules }); await db.courseChapter.createMany({ data: chapters }); await db.exam.createMany({ data: exams });
  // The browser acceptance path exercises every attempt through the learner API.
  // Keep the adversarial duplicate/cross-access fixture in the regular and restore suites.
  const full = process.env.TRAINERB_CERTIFICATE_BROWSER === 'yes';
  const pools = (full ? exams : exams.slice(-2)).map(e => ({id:uuidv7(),exam_id:e.id,title:'Testpool'}));
  const questions = pools.flatMap(p => [1,2,3].map(position => ({id:uuidv7(),exam_id:p.exam_id,pool_id:p.id,position,
    question_text:`Testfrage ${position}`, explanation:'Synthetischer Test.'})));
  await db.questionPool.createMany({data:pools});await db.question.createMany({data:questions});
  await db.answerOption.createMany({data:questions.flatMap(q=>[1,2,3,4].map(position=>({id:uuidv7(),question_id:q.id,position,
    option_text:`Option ${position}`,is_correct:position===1})))});
  await db.question.updateMany({where:{id:{in:questions.map(q=>q.id)}},data:{status:'active'}});
  if(full)await db.chapterContent.createMany({data:chapters.map(c=>{
    const id=uuidv7();return {id,course_version_id:version,chapter_id:c.id,position:1,kind:'text',
      body:{schema_version:1,blocks:[{id,kind:'paragraph',text:'Synthetischer Lerninhalt.'}]}};
  })});
  const readiness = await admin.get(`/admin/courses/${course.id}/publication`); status(readiness,200);
  assert.ok(readiness.body.readiness.some(item => item.code === 'QUALIFICATION_NOT_READY'));
  // Isolated DB fixture only; no production bypass or seeded qualification content.
  await db.courseVersion.update({ where:{ id:version }, data:{ state:'published', published_by:adminUser.id, published_at:new Date() } });
  await db.course.update({ where:{id:course.id}, data:{status:'published'} });
  await db.coursePublication.create({ data:{ id:uuidv7(), course_id:course.id, course_version_id:version, version:1, action:'published', actor_user_id:adminUser.id } });
  const grant = user_id => db.courseAccess.create({data:{id:uuidv7(), course_id:course.id, course_version_id:version, user_id, source:'manual', granted_by:adminUser.id}});
  const access = full ? await buyQualification(course) : (await grant((await contextFor(participant)).user.id)).id;
  const other = (await grant(adminUser.id)).id;
  if (!full) {
    await db.chapterProgress.createMany({data:chapters.map(c => ({id:uuidv7(), access_id:access, course_version_id:version, chapter_id:c.id}))});
    const stub = (access_id, exam_id, attempt_no, passed) => ({ id:uuidv7(), access_id, exam_id, attempt_no, passed });
    const previous = [...exams.slice(0,82).map(e => stub(access,e.id,1,true)), stub(access,exams[0].id,2,true),
      stub(access,exams[83].id,1,false), stub(other,exams[83].id,1,true)];
    // Store the duplicate pass after closing the original attempt: only one attempt may be open at once.
    for (const batch of [previous.filter(a => a.attempt_no === 1), previous.filter(a => a.attempt_no === 2)]) {
      await db.examAttempt.createMany({data:batch.map(({passed,...a}) => ({...a, course_version_id:version, start_idempotency_key:randomUUID()}))});
      await db.examAttemptResult.createMany({data:batch.map(a => ({attempt_id:a.id, submit_key:randomUUID(), correct_count:a.passed?3:2, passed:a.passed}))});
      await db.examAttempt.updateMany({where:{id:{in:batch.map(a=>a.id)}}, data:{status:'submitted',submitted_at:new Date()}});
    }
  }
  async function attempt(exam, parallel, client = participant, correct = true) {
    const base = `/enrollments/${access}/exams/${exam.id}/attempts`;
    const start = await client.change('post',base,{}, {key:randomUUID()}); status(start,200);
    const answers = start.body.questions.map(q=>({question_id:q.id, option_id:q.options.find(o=>o.text===(correct?'Option 1':'Option 2')).id}));
    const key = randomUUID(), send = () => client.change('post',`${base}/${start.body.id}/submit`,{answers},{key});
    for (const res of await Promise.all(parallel ? [send(), send()] : [send()])) {status(res,200); if(correct)assert.equal(res.body.status,'passed'); else assert.deepEqual(res.body,{id:start.body.id,status:'failed'});}
  }
  let activeClient=participant;
  if(full){
    await attempt(exams[0],false,activeClient,false);
    for(let i=0;i<82;i++){
      if(i===42){
        activeClient=new Browser();status(await login(activeClient,(await contextFor(participant)).user.email_canonical),200);
        const resumed=await activeClient.get(`/me/courses/${slug}`);status(resumed,200);
        assert.equal(resumed.body.modules.flatMap(m=>m.chapters).filter(c=>c.completed_at).length,21);
      }
      if(i%2===0){const lesson=await activeClient.get(`/me/courses/${slug}/chapters/${exams[i].chapter_id}`);status(lesson,200);assert.equal(lesson.body.contents.length,1);}
      await attempt(exams[i],false,activeClient);
    }
    const lastLesson=await activeClient.get(`/me/courses/${slug}/chapters/${exams[82].chapter_id}`);status(lastLesson,200);
  }
  await attempt(exams[82],false,activeClient);
  const outline = `/me/courses/${slug}`;
  assert.equal((await participant.get(outline)).body.completed_at,null);
  assert.equal(await db.completionRecord.count({where:{access_id:access}}),0);
  assert.equal(await db.certificate.count({where:{course_version_id:version}}),0);
  await attempt(exams[83],true,activeClient);
  const records = await db.completionRecord.findMany({where:{course_version_id:version}}); assert.equal(records.length,1);
  const [record] = records; assert.equal(record.access_id,access); assert.equal(record.completion_profile,profile);
  assert.deepEqual(new Set(record.evidence_snapshot.exams.map(e=>e.id)),new Set(exams.map(e=>e.id)));
  assert.equal(record.evidence_snapshot.chapters.length,42);
  assert.equal((await participant.get(outline)).body.completed_at,record.completed_at.toISOString());
  assert.equal((await admin.get(outline)).body.completed_at,null);
  await assert.rejects(db.completionRecord.update({where:{id:record.id},data:{completed_at:new Date()}}), /COMPLETION_RECORD_IMMUTABLE/);
});

test('certificate queue: retry, private immutable PDF after expiry, public verification, revocation and explicit reissue', async () => {
  const {issueNextCertificate} = require('../../apps/api/dist/certificate-worker');
  const {Outbox} = require('../../apps/api/dist/outbox'); const outbox = app.get(Outbox);
  const {PDFDocument} = require('pdf-lib');
  const mine = await participant.get('/me/certificates'); status(mine,200); assert.equal(mine.body.data.length,1);
  const cert=mine.body.data[0]; assert.equal(cert.status,'queued');
  const path=`/me/certificates/${cert.id}/download`, worker=()=>issueNextCertificate(db,outbox);
  const noticeCount=()=>db.emailOutbox.count({where:{template_version:{template:{key:'certificate_ready'}}}});
  status(await participant.get(path),404); assert.equal(await noticeCount(),0);
  const job=await db.certificate.findUniqueOrThrow({where:{id:cert.id}});
  const record=await db.completionRecord.findUniqueOrThrow({where:{id:job.completion_id}});
  await db.courseAccess.update({where:{id:record.access_id}, data:{starts_at:new Date(Date.now()-86400000),ends_at:new Date(Date.now()-1000),suspended_at:new Date(),suspend_reason:'review'}});
  const stalled=async()=>(await db.$queryRaw`SELECT certificate_stalled FROM public.operations_probe_v1`)[0].certificate_stalled;
  await db.certificate.update({where:{id:cert.id},data:{retry_at:new Date(0)}});assert.equal(await stalled(),false);
  assert.equal(await worker(),false); await db.courseAccess.update({where:{id:record.access_id},data:{suspended_at:null,suspend_reason:null}});
  assert.equal(await stalled(),true);
  await assert.rejects(issueNextCertificate(db,outbox,async()=>{throw new Error('synthetic render failure');}));
  assert.equal(await stalled(),false);
  assert.equal(await noticeCount(),0);
  assert.equal((await db.certificate.findUniqueOrThrow({where:{id:cert.id}})).last_error,'ISSUANCE_FAILED');
  await db.certificate.update({where:{id:cert.id},data:{retry_at:new Date(0)}});
  assert.deepEqual((await Promise.all([worker(),worker()])).sort(),[false,true]); assert.equal(await noticeCount(),1);
  const row=await db.certificate.findUniqueOrThrow({where:{id:cert.id}}), doc=unseal(row.document_ciphertext,`certificate:${row.id}`,row.key_id);
  const user=(await contextFor(participant)).user; assert.equal(doc.snapshot.first_name,user.first_name); assert.equal(doc.snapshot.last_name,user.last_name);
  assert.equal(doc.snapshot.number,cert.id); assert.equal(doc.snapshot.heading,'Testurkunde');
  const verify=async token=>(await new Browser().change('post','/certificates/verify',{token})).body;
  assert.deepEqual(await verify(doc.snapshot.token),{status:'valid'}); assert.deepEqual(await verify('not-a-code'),{status:'unknown'});
  status(await admin.get(path),404); status(await new Browser().get(path),401);
  const file=await participant.get(path); status(file,200); assert.match(file.headers['cache-control'],/no-store/);
  assert.equal((await PDFDocument.load(file.body)).getPageCount(),1); assert.deepEqual(file.body,Buffer.from(doc.pdf,'base64'));
  await db.user.update({where:{id:user.id},data:{first_name:'Renate'}}); assert.deepEqual((await participant.get(path)).body,file.body);
  const revoke=`/admin/certificates/${cert.id}/revoke`, reason={reason:'Synthetischer Test'};
  status(await participant.change('post',revoke,reason),403);
  status(await admin.change('post',revoke,reason,{noCsrf:true}),403);
  const staff = await contextFor(admin);
  await db.authSession.update({where:{id:staff.session.id},data:{reauthenticated_at:new Date(Date.now()-360000)}});
  status(await admin.change('post',revoke,reason),403);
  status(await admin.change('post','/auth/reauth',{password,recovery_code:adminRecovery[6]}),204);
  status(await admin.change('post',revoke,reason),200); status(await participant.get(path),404);
  assert.deepEqual(await verify(doc.snapshot.token),{status:'revoked'});
  const reissue=()=>admin.change('post',`/admin/completions/${record.id}/reissue`,{revoked_id:cert.id});
  const results=await Promise.all([reissue(),reissue()]); results.forEach(r=>status(r,200)); assert.equal(results[0].body.id,results[1].body.id);
  await db.user.update({where:{id:user.id},data:{status:'deletion_requested'}});
  assert.equal(await worker(),false); assert.equal(await noticeCount(),1);
  await db.user.update({where:{id:user.id},data:{status:'active'}});
  assert.equal(await worker(),true); assert.equal(await noticeCount(),2);
  assert.equal(await db.certificate.count({where:{completion_id:record.id,status:'valid'}}),1);
  assert.equal((await admin.get('/admin/dashboard')).body.completions,1);
  assert.deepEqual(await verify(doc.snapshot.token),{status:'revoked'});
  // A POST limit applies even to unknown codes, and responses disclose no identities.
  const publicRequest=()=>request(server).post('/api/v1/certificates/verify').send({token:'?' });
  let response;
  for(let i=0;i<31;i++){response=await publicRequest(); if(response.status===429)break; assert.equal(response.status,200);}
  status(response,429);

});

// The opt-in runner selects this test and the qualification fixture above, not
// the queue fault-injection test. The standalone real worker owns the queued job.
test('browser certificate acceptance: SMTP, private PDF, verification, revocation and replacement',
  {skip: process.env.TRAINERB_CERTIFICATE_BROWSER !== 'yes', timeout:120000}, async () => {
    const owner = (await contextFor(participant)).user;
    await db.user.update({where:{id:owner.id},data:{first_name:'Élodie-Luise Friederike Antonia',last_name:'Groß-Schönfeld von Winterstein-Hohenweide'}});
    await require('../e2e/certificate-acceptance.cjs').exercise({admin, participant, ownerEmail:owner.email_canonical});
  });

test('backoffice mail: version pinning, concurrent publishing, private monitoring and retry only before SMTP', async () => {
  const template = '/admin/certificate-mail-template', jobs = '/admin/automation-jobs';
  const confirmation=()=>admin.change('post','/auth/reauth',{password,recovery_code:adminRecovery[7]});
  const ctx=await contextFor(admin);
  await db.authSession.update({where:{id:ctx.session.id},data:{reauthenticated_at:new Date(Date.now()-360000)}});
  const initial=await admin.get(template);status(initial,200);const old=initial.body.published;
  const draft={base_id:old.id,subject:'Dein Dokument',text:'Hallo {{first_name}}, deine Urkunde ist bereit.'};
  const save=(body,opts)=>admin.change('post',template+'/drafts',body,opts);
  status(await save(draft),403);status(await confirmation(),204);
  status(await save(draft,{noCsrf:true}),403);
  status(await participant.change('post',template+'/drafts',draft),403);
  for(const bad of [{text:'{{token}}'},{text:'<a href="https://example.invalid">Link</a>'},{subject:'Betreff\nzweite Zeile'}]) status(await save({...draft,...bad}),422);
  const {Outbox}=require('../../apps/api/dist/outbox');const outbox=app.get(Outbox);
  const owner=(await contextFor(participant)).user;
  async function mail(){
    await db.$transaction(tx=>outbox.notify(tx,owner.id,owner.email_original,'Mila','certificate_ready'));
    const item=await db.emailOutbox.findFirstOrThrow({where:{user_id:owner.id,template_version:{template:{key:'certificate_ready'}}},orderBy:{id:'desc'}});
    return {item,job:await db.automationJob.findFirstOrThrow({where:{ref_id:item.id}})};
  }
  const first=await mail();assert.equal(first.item.template_version_id,old.id);
  const concurrent=await Promise.all([save(draft),save(draft)]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[201,409]);
  const v=concurrent.find(r=>r.status===201).body;
  assert.equal((await admin.get(template)).body.published.id,old.id);
  const revised=await save({...draft,base_id:v.id,text:'Hallo {{first_name}}, schau in dein Konto.'});status(revised,201);
  const publish=id=>admin.change('post',template+'/publish',{draft_id:id});status(await publish(v.id),409);
  assert.deepEqual((await Promise.all([publish(revised.body.id),publish(revised.body.id)])).map(r=>r.status).sort(),[200,409]);
  const second=await mail();assert.equal(second.item.template_version_id,revised.body.id);
  const {MailWorker}=require('../../apps/api/dist/mail-worker');const sent=[];
  const worker=new MailWorker(db,{sendMail:async m=>{sent.push(m);return {accepted:[m.to]};}});
  await worker.runOne(first.job.id);assert.equal(sent[0].subject,old.subject_template);
  // Fault before transport; retain the job, bound template and attempt history.
  await db.automationJob.update({where:{id:second.job.id},data:{max_attempts:1}});
  await db.emailOutbox.update({where:{id:second.item.id},data:{variables_public:{}}});await worker.runOne(second.job.id);
  assert.equal(sent.length,1);
  const failed=await admin.get(jobs+'?status=failed');status(failed,200);
  const row=failed.body.data.find(j=>j.id===second.job.id);assert.equal(row.error_code,'MAIL_PREPARATION_FAILED');assert.equal(row.retry_candidate,true);
  assert.deepEqual(Object.keys(row).sort(),['attempts','error_code','finished_at','id','max_attempts','retry_candidate','run_after','status']);
  const retry=(id,n=1,browser=admin,opts)=>browser.change('post',`${jobs}/${id}/retry`,{expected_attempts:n},opts);
  status(await retry(second.job.id,1,participant),403);status(await retry(second.job.id,1,admin,{noCsrf:true}),403);
  status(await retry(second.job.id,2),409);
  await db.emailOutbox.update({where:{id:second.item.id},data:{variables_public:{first_name:'Mila'}}});
  assert.deepEqual((await Promise.all([retry(second.job.id),retry(second.job.id)])).map(r=>r.status).sort(),[200,409]);
  await worker.runOne(second.job.id);assert.equal(sent.length,2);assert.equal(sent[1].text,'Hallo Mila, schau in dein Konto.');
  status(await retry(second.job.id,2),409);
  assert.equal(await db.automationJobAttempt.count({where:{automation_job_id:second.job.id}}),2);
  const third=await mail();await db.automationJob.update({where:{id:third.job.id},data:{max_attempts:1}});
  const ambiguous=new MailWorker(db,{sendMail:async()=>{throw new Error('transport outcome unknown');}});await ambiguous.runOne(third.job.id);
  status(await retry(third.job.id),409);assert.equal((await admin.get(jobs+'?status=failed')).body.data.find(j=>j.id===third.job.id).retry_candidate,false);
  assert.equal(await db.auditEvent.count({where:{target_ref:second.job.id,action:'automation_job.retry_requested'}}),1);
  status(await admin.get(jobs+'?status=anything'),422);status(await admin.get(jobs+'?payload=1'),400);
});

test('expiry reminders merge touching periods, ignore gaps and recheck grant changes before delivery',async()=>{
  const {queueExpiryNotices}=require('../../apps/api/dist/expiry-notices'),{MailWorker}=require('../../apps/api/dist/mail-worker');
  const outbox=app.get(require('../../apps/api/dist/outbox').Outbox),messages=[],worker=new MailWorker(db,{sendMail:async m=>{messages.push(m);return {accepted:[m.to],messageId:m.messageId};}});
  const person=await db.user.findUniqueOrThrow({where:{email_canonical:'catalog-participant@example.invalid'}}),cid=uuidv7(),vid=uuidv7();
  await db.course.create({data:{id:cid,slug:'ablauffixture',status:'published',visibility:'private'}});
  await db.courseVersion.create({data:{id:vid,course_id:cid,version:1,title:'Ablauftest',description:{schema_version:1,blocks:[]},state:'published',created_by:adminUser.id,published_by:adminUser.id,published_at:new Date()}});
  await db.coursePublication.create({data:{id:uuidv7(),course_id:cid,course_version_id:vid,version:1,action:'published',actor_user_id:adminUser.id}});
  const now=Date.now(),d=86400000,end=new Date(now+4*d),edge=new Date(now+d/2);
  const grant=(a,b)=>db.courseAccess.create({data:{id:uuidv7(),course_id:cid,course_version_id:vid,user_id:person.id,source:'manual',granted_by:adminUser.id,starts_at:a,ends_at:b}});
  await grant(new Date(now-d),edge);await grant(edge,end);await grant(new Date(now+10*d),null);
  const own=()=>db.accessExpiryNotice.findMany({where:{course_id:cid}});
  async function deliver(notice){const job=await db.automationJob.findFirstOrThrow({where:{ref_id:notice.outbox_id}});await worker.runOne(job.id);return (await db.emailOutbox.findUniqueOrThrow({where:{id:notice.outbox_id}})).status;}
  process.env.ACCESS_EXPIRY_NOTICES_ENABLED='true';try{
    await Promise.all([queueExpiryNotices(db,outbox),queueExpiryNotices(db,outbox)]);let notices=await own();assert.equal(notices.length,1);assert.equal(notices[0].ends_at.getTime(),end.getTime());assert.equal(notices[0].window_days,7);
    const extension=await grant(end,new Date(now+8*d));assert.equal(await deliver(notices[0]),'suppressed');assert.equal(messages.length,0);
    await db.courseAccess.update({where:{id:extension.id},data:{revoked_at:new Date(),revoke_reason:'test'}});
    const adjacent=await db.courseAccess.findFirstOrThrow({where:{course_id:cid,starts_at:edge}});await db.courseAccess.update({where:{id:adjacent.id},data:{suspended_at:new Date(),suspend_reason:'review'}});
    await queueExpiryNotices(db,outbox);notices=await own();assert.equal(notices.length,2);const soon=notices.find(n=>n.window_days===1);assert.equal(await deliver(soon),'accepted');assert.equal(messages.length,1);assert.match(messages[0].text,/Ablauftest/);
  }finally{delete process.env.ACCESS_EXPIRY_NOTICES_ENABLED;}
});
