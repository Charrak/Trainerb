const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

// The transaction is rolled back even on failure. This runs only in the disposable suite.
test('operations view distinguishes delayed work from future, resolved and withdrawn work', async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE,'confirmed');
  assert.equal(process.env.APP_ENV,'test'); assert.match(new URL(process.env.DATABASE_URL).pathname,/_test$/);
  const { evaluate } = await import('../../scripts/operations-probe.mjs');
  const db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
  const probe = async () => evaluate((await db.query('SELECT * FROM public.operations_probe_v1')).rows).alerts;
  try {
    await db.query('BEGIN');
    await db.query('TRUNCATE automation_jobs,course_media_uploads,certificates,orders CASCADE');
    const mail=randomUUID();
    await db.query(`INSERT INTO automation_jobs(id,kind,ref_type,payload_schema_version,payload,idempotency_key,status,max_attempts,run_after)
      VALUES($1,'email.send','email_outbox',1,'{}',$1::uuid::text,'queued',4,now()+interval '1 hour')`,[mail]);
    assert.deepEqual(await probe(),[]);
    await db.query("UPDATE automation_jobs SET run_after=now()-interval '10 minutes'");
    assert.deepEqual(await probe(),['mail_overdue']);
    await db.query("UPDATE automation_jobs SET status='running',lease_until=now()+interval '1 minute'");
    assert.deepEqual(await probe(),[]);
    await db.query("UPDATE automation_jobs SET lease_until=now()-interval '5 minutes'");
    assert.deepEqual(await probe(),['mail_lease_stalled']);
    await db.query("UPDATE automation_jobs SET status='failed',finished_at=now()");
    assert.deepEqual(await probe(),['mail_failed_24h']);
    await db.query("UPDATE automation_jobs SET finished_at=now()-interval '25 hours'");
    const who=randomUUID(), reviewer=randomUUID(), img=randomUUID();
    for (const id of [who,reviewer]) await db.query("INSERT INTO users(id,status,first_name,last_name,email_original,email_canonical) VALUES ($1,'pending_activation','Bild','Test',$2,$2)",[id,`${id}@example.invalid`]);
    await db.query(`INSERT INTO course_media_uploads(id,uploaded_by,intended_use,object_key,original_name,mime_detected,size_bytes,sha256,created_at)
      VALUES($1,$2,'website',$3,'test.png','image/png',100,decode(repeat('00',32),'hex'),now()-interval '30 minutes')`,[img,who,randomUUID()]);
    assert.deepEqual(await probe(),['scan_overdue']);
    await db.query("UPDATE course_media_uploads SET status='scan_error',scan_error='scanner',scanned_at=now()");
    assert.deepEqual(await probe(),['scan_failed_24h']);
    await db.query("UPDATE course_media_uploads SET status='clean',scan_error=NULL");
    assert.deepEqual(await probe(),[]); // No alert while awaiting editorial review.
    await db.query("UPDATE course_media_uploads SET approved_by=$1,approved_at=now()-interval '30 minutes',rights_ref='TEST-38'",[reviewer]);
    assert.deepEqual(await probe(),['promotion_stalled']);
    await db.query('UPDATE course_media_uploads SET rights_withdrawn_at=now()');
    assert.deepEqual(await probe(),[]);
    if(process.env.TEST_PRIVILEGED_ROLE_CHECK==='yes') {
      const role='monitor_'+randomUUID().replaceAll('-','');
      await db.query(`CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON public.operations_probe_v1 TO ${role}; SET LOCAL ROLE ${role}`);
      assert.deepEqual(await probe(),[]);
      await assert.rejects(db.query('SELECT buyer_email_original FROM public.orders'),{code:'42501'});
    }
  } finally { await db.query('ROLLBACK'); await db.end(); }
});
