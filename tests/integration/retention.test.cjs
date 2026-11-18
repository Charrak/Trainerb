const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { uuidv7 } = require('uuidv7');
const { Database } = require('../../apps/api/dist/database');
const { createApplication } = require('../../apps/api/dist/application');
const { runRetention } = require('../../apps/api/dist/retention');

/**
 * Retention is the one process allowed to remove personal data, so these tests
 * are about what it *must not* touch as much as about what it removes: a closed
 * invoice, a dispute or an audit event survives every pass.
 */
let db, app, server;
const daysAgo = days => new Date(Date.now() - days * 24 * 60 * 60_000);

before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
  app = await createApplication(); await app.listen(0, '127.0.0.1'); server = app.getHttpServer();
  db = app.get(Database);
});
after(async () => { await app?.close(); });

test('retention removes only what has stopped being necessary, and says how much', async () => {
  // The suite shares one database with the other files; any user will do.
  const admin = await db.user.findFirstOrThrow();
  // An expired token and a live one; an old revoked session and a fresh one.
  const expired = await db.accountToken.create({ data: { id: uuidv7(), user_id: admin.id, purpose: 'email_verify',
    token_hash: Buffer.from(`expired-${uuidv7()}`), expires_at: daysAgo(30) } });
  const live = await db.accountToken.create({ data: { id: uuidv7(), user_id: admin.id, purpose: 'email_verify',
    token_hash: Buffer.from(`live-${uuidv7()}`), expires_at: new Date(Date.now() + 86_400_000) } });
  const staleSession = await db.authSession.create({ data: { id: uuidv7(), user_id: admin.id, kind: 'participant',
    token_hash: Buffer.from(`stale-${uuidv7()}`), csrf_secret_hash: Buffer.from('csrf'),
    last_seen_at: daysAgo(90), created_at: daysAgo(120), expires_at: daysAgo(60), revoked_at: daysAgo(60) } });
  const freshSession = await db.authSession.create({ data: { id: uuidv7(), user_id: admin.id, kind: 'participant',
    token_hash: Buffer.from(`fresh-${uuidv7()}`), csrf_secret_hash: Buffer.from('csrf'),
    last_seen_at: new Date(), expires_at: new Date(Date.now() + 86_400_000) } });

  // A completed case always names its purchase, so the fixture needs one.
  const linkedOrder = await db.order.findFirstOrThrow();
  // A withdrawal case whose address is past retention, and one decided yesterday.
  const oldCase = await db.withdrawalRequest.create({ data: { id: uuidv7(), order_id: linkedOrder.id,
    contact_email: 'alt@example.invalid', contact_email_hmac: Buffer.from(`hmac-${uuidv7()}`),
    status: 'completed', processed_by: admin.id, processed_at: daysAgo(400),
    decision_reason: 'withdrawal_accepted', submitted_at: daysAgo(420) } });
  const recentCase = await db.withdrawalRequest.create({ data: { id: uuidv7(), order_id: linkedOrder.id,
    contact_email: 'neu@example.invalid', contact_email_hmac: Buffer.from(`hmac-${uuidv7()}`),
    status: 'completed', processed_by: admin.id, processed_at: daysAgo(2),
    decision_reason: 'withdrawal_accepted', submitted_at: daysAgo(5) } });
  const openCase = await db.withdrawalRequest.create({ data: { id: uuidv7(), contact_email: 'offen@example.invalid',
    contact_email_hmac: Buffer.from(`hmac-${uuidv7()}`), status: 'received', submitted_at: daysAgo(500) } });

  const invoiceBefore = await db.invoice.count();
  const auditBefore = await db.auditEvent.count();

  const dry = await db.$transaction(tx => runRetention(tx, { dryRun: true }));
  assert.equal(dry.withdrawal_addresses_scrubbed, 1);
  // A dry run reports what it *would* do and changes nothing at all.
  assert.ok(dry.account_tokens_deleted >= 1);
  assert.ok(dry.sessions_deleted >= 1);
  assert.equal(await db.accountToken.count({ where: { id: expired.id } }), 1);
  assert.equal(await db.authSession.count({ where: { id: staleSession.id } }), 1);
  // A dry run changes nothing.
  assert.equal((await db.withdrawalRequest.findUniqueOrThrow({ where: { id: oldCase.id } })).contact_email,
    'alt@example.invalid');

  const report = await db.$transaction(tx => runRetention(tx));
  assert.ok(report.account_tokens_deleted >= 1);
  assert.ok(report.sessions_deleted >= 1);
  assert.equal(report.withdrawal_addresses_scrubbed, 1);
  assert.equal(await db.accountToken.count({ where: { id: expired.id } }), 0);
  assert.equal(await db.accountToken.count({ where: { id: live.id } }), 1);
  assert.equal(await db.authSession.count({ where: { id: staleSession.id } }), 0);
  assert.equal(await db.authSession.count({ where: { id: freshSession.id } }), 1);

  const scrubbed = await db.withdrawalRequest.findUniqueOrThrow({ where: { id: oldCase.id } });
  // The case and its decision stay: the address is the only thing that goes.
  assert.equal(scrubbed.contact_email, null);
  assert.ok(scrubbed.contact_email_scrubbed_at);
  assert.equal(scrubbed.decision_reason, 'withdrawal_accepted');
  assert.equal((await db.withdrawalRequest.findUniqueOrThrow({ where: { id: recentCase.id } })).contact_email,
    'neu@example.invalid');
  assert.equal((await db.withdrawalRequest.findUniqueOrThrow({ where: { id: openCase.id } })).contact_email,
    'offen@example.invalid');

  // Evidence is untouched, and the run itself is documented.
  assert.equal(await db.invoice.count(), invoiceBefore);
  assert.ok(await db.auditEvent.count() > auditBefore);
  const entry = await db.auditEvent.findFirst({ where: { action: 'retention.run' }, orderBy: { created_at: 'desc' } });
  assert.ok(entry);

  // A second pass finds nothing more to do — it is idempotent by construction.
  const again = await db.$transaction(tx => runRetention(tx));
  assert.equal(again.withdrawal_addresses_scrubbed, 0);

  // The database itself refuses a case that was never emailed but has no reason
  // for it: "address removed" and "never had one" must stay distinguishable.
  await assert.rejects(db.withdrawalRequest.create({ data: { id: uuidv7(), contact_email: null,
    contact_email_hmac: Buffer.from(`hmac-${uuidv7()}`), status: 'received', submitted_at: daysAgo(2) } }));
  const withdrawn = await db.withdrawalRequest.create({ data: { id: uuidv7(), contact_email: null,
    contact_email_hmac: Buffer.from(`hmac-${uuidv7()}`), status: 'received',
    contact_email_scrubbed_at: daysAgo(1), submitted_at: daysAgo(2) } });
  assert.ok(withdrawn.contact_email_scrubbed_at);
});

test('a chargeback is recorded from a provider report and keeps its source', async () => {
  const order = await db.order.findFirstOrThrow({ where: { payment_state: 'paid', payment_method: 'invoice' } });
  const attempt = await db.paymentAttempt.create({ data: { id: uuidv7(), order_id: order.id, provider: 'stripe',
    environment: 'test', provider_idempotency_key: `idem-${uuidv7()}`, status: 'succeeded',
    amount_cents: order.total_gross_cents, currency: order.currency, confirmed_at: new Date() } });
  const disputeIdRef = `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`;
  const { Disputes } = require('../../apps/api/dist/disputes');
  const { Refunds } = require('../../apps/api/dist/refunds');
  const { Outbox } = require('../../apps/api/dist/outbox');
  const { Sessions } = require('../../apps/api/dist/sessions');
  const sessions = app.get(Sessions);
  const disputes = new Disputes(db, sessions, app.get(Refunds), app.get(Outbox));
  const body = { provider_dispute_id: disputeIdRef, amount_cents: String(order.total_gross_cents),
    status: 'open', reason_code: 'product_not_received' };
  const created = await disputes.record(null, order.id, body, { source: 'webhook' });
  assert.equal(created.status, 'open');
  assert.equal(created.sync_source, 'webhook');
  assert.ok(created.last_synced_at);
  // A repeated delivery updates the same row instead of opening a second case.
  const updated = await disputes.record(null, order.id, { ...body, status: 'won' }, { source: 'webhook' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.status, 'won');
  assert.equal(await db.dispute.count({ where: { provider_dispute_id: disputeIdRef } }), 1);
  // A changed amount is a disagreement, not an update.
  await assert.rejects(disputes.record(null, order.id,
    { ...body, amount_cents: String(order.total_gross_cents - 1n) }, { source: 'webhook' }),
  error => /Betrag weicht/.test(error.message));
  // A won case restores the payment state if nothing else explains a gap.
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).payment_state, 'paid');
  assert.ok(attempt);
});
