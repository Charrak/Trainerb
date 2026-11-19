const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { uuidv7 } = require('uuidv7');
const { createApplication } = require('../../apps/api/dist/application');
const { Database } = require('../../apps/api/dist/database');

/**
 * The Stripe webhook, exercised end to end through HTTP.
 *
 * Stripe is not configured in this environment (no `sk_test_…`), so the module
 * answers `409 STRIPE_UNAVAILABLE` and would prove nothing. The tests therefore
 * set test credentials in `process.env` *before* the app is created — `config`
 * caches on first read — and replace only the network layer of the Stripe client
 * with a stub. Signature verification, routing, idempotency, order lookup and
 * the database writes are the real ones.
 *
 * Focus: money that arrives must never disappear silently, and a second session
 * must not invite a second payment.
 */
const secretKey = 'sk_test_webhook_stub';
const webhookSecret = 'whsec_webhook_stub';
let app, server, db, stripe;

/** Deterministically sign a body the way Stripe does. */
function signature(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = `${timestamp}.${payload}`;
  const mac = crypto.createHmac('sha256', webhookSecret).update(signed).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

async function deliver(event) {
  const payload = JSON.stringify(event);
  return request(server).post('/api/v1/payments/stripe/webhook')
    .set('Content-Type', 'application/json').set('Stripe-Signature', signature(payload)).send(payload);
}

let eventCounter = 0;
function paidEvent(order, { amount, currency = 'EUR', sessionId = `cs_test_${uuidv7()}`, intentId } = {}) {
  return { id: `evt_${uuidv7()}${eventCounter++}`, object: 'event', api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000), livemode: false, type: 'checkout.session.completed',
    pending_webhooks: 1, request: { id: null, idempotency_key: null },
    data: { object: { id: sessionId, object: 'checkout.session', amount_total: amount ?? Number(order.total_gross_cents),
      currency: currency.toLowerCase(), payment_status: 'paid', status: 'complete',
      client_reference_id: order.id, metadata: { order_id: order.id, order_number: order.order_number },
      payment_intent: intentId ?? `pi_test_${uuidv7()}` } } };
}

before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
  process.env.STRIPE_SECRET_KEY = secretKey;
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_webhook_stub';
  stripe = { sessions: new Map() };
  app = await createApplication(); await app.listen(0, '127.0.0.1'); server = app.getHttpServer();
  db = app.get(Database);
});

after(async () => {
  await app?.close();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  // `config` caches; the other test files run in this process only if they
  // share it, and the runner uses one file per process (`--test`).
});

/**
 * The real `StripePayments` service with only its *network* replaced.
 *
 * Signature verification stays the genuine one (it is pure HMAC), and only
 * `checkout.sessions` talks to a stub — no test here reaches Stripe.
 */
function stripeService() {
  const { StripePayments } = require('../../apps/api/dist/stripe');
  const payments = app.get(StripePayments);
  const real = payments.client;
  payments.client = {
    webhooks: real.webhooks,
    checkout: { sessions: {
      create: async payload => ({ id: `cs_test_${uuidv7()}`, status: 'open',
        url: `https://stripe.test/pay/${uuidv7()}`, payload }),
      retrieve: async id => stripe.sessions.get(id) ?? { id, status: 'expired' },
    } },
  };
  return payments;
}

/** A minimal but constraint-clean order for one product. */
async function makeOrder(state = 'awaiting') {
  const suffix = Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  // `users_activation_check` requires a password and a verified address for an
  // active account, so the fixture sets both instead of faking the state.
  const user = await db.user.findFirst({ where: { status: 'active' } })
    ?? await db.user.create({ data: { id: uuidv7(), email_original: `w${suffix}@example.invalid`,
      email_canonical: `w${suffix}@example.invalid`, first_name: 'Web', last_name: 'Hook', status: 'active',
      password_hash: `hash-${suffix}`, email_verified_at: new Date() } });
  return db.order.create({ data: { id: uuidv7(), order_number: `TB-2026-${suffix.slice(-6)}`,
    checkout_idempotency_key: `wh-${uuidv7()}`, user_id: user.id, identity_kind: 'account', created_by: user.id,
    buyer_email_original: user.email_original, buyer_email_canonical: user.email_canonical,
    currency: 'EUR', payment_method: 'stripe', payment_state: state,
    subtotal_gross_cents: 19900n, discount_cents: 0n, total_gross_cents: 19900n,
    billing_snapshot: { first_name: 'Web', last_name: 'Hook', country: 'DE' },
    ...(state === 'paid' ? { paid_at: new Date(), paid_via: 'provider',
      fulfillment_state: 'fulfilled', fulfilled_at: new Date() } : {}),
    ...(state === 'cancelled' ? { cancelled_at: new Date(), cancelled_reason: 'customer_request' } : {}) } });
}

test('a payment for a cancelled order is not swallowed: the order goes to review and is audited', async () => {
  const order = await makeOrder('cancelled');
  const response = await deliver(paidEvent(order));
  assert.equal(response.status, 200);
  assert.equal(response.body.received, true);

  const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(after.payment_state, 'review', 'money arrived although the order was cancelled');
  // The payment itself stays recorded as an event.
  assert.equal(await db.paymentEvent.count({ where: { order_id: order.id } }), 1);
  const audit = await db.auditEvent.findFirst({ where: { target_ref: order.id, action: 'payment.unmatched' } });
  assert.ok(audit, 'the unmatched payment is written down');
  assert.equal(audit.origin, 'provider');
  assert.equal(audit.after_safe.reason, 'payment_after_cancellation');
  // Nothing was fulfilled and nothing was refunded automatically.
  assert.equal(after.paid_at, null);
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id } }), 0);
});

test('a second payment for an already paid order is reported instead of ignored', async () => {
  // The order is already paid and has the attempt that booked it. Building it
  // directly keeps the test about the webhook, not about fulfilment.
  const order = await makeOrder('paid');
  const firstIntent = `pi_test_${uuidv7()}`;
  const sessionId = `cs_test_${uuidv7()}`;
  await db.paymentAttempt.create({ data: { id: uuidv7(), order_id: order.id, provider: 'stripe',
    environment: 'test', provider_session_id: sessionId, provider_payment_id: firstIntent,
    provider_idempotency_key: `idem-${uuidv7()}`, status: 'succeeded', confirmed_at: new Date(),
    amount_cents: order.total_gross_cents, currency: order.currency } });

  // A late replay of the *same* payment is a duplicate and stays quiet.
  const replay = paidEvent(order, { sessionId, intentId: firstIntent });
  const replayed = await deliver(replay);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  await deliver(replay);
  assert.equal(await db.auditEvent.count({ where: { target_ref: order.id, action: 'payment.unmatched' } }), 0,
    'the same payment twice is not an event');

  // A *new* payment (second session, second intent) is real money we did not
  // book: it must be visible, but a settled order never leaves `paid`.
  const second = paidEvent(order, { sessionId: `cs_test_${uuidv7()}`, intentId: `pi_test_${uuidv7()}` });
  const response = await deliver(second);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(after.payment_state, 'paid', 'a paid order is not downgraded to review');
  const audit = await db.auditEvent.findFirst({ where: { target_ref: order.id, action: 'payment.unmatched' } });
  assert.ok(audit, 'the unmatched second payment is written down');
  assert.equal(audit.after_safe.reason, 'duplicate_payment');
  assert.equal(audit.after_safe.previous_payment_state, 'paid');
  // Nothing happened to the access of the first purchase.
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id, revoked_at: null } }), 0);
});

test('an amount mismatch parks an open order in review but never rewrites a paid one', async () => {
  const open = await makeOrder('awaiting');
  await db.paymentAttempt.create({ data: { id: uuidv7(), order_id: open.id, provider: 'stripe',
    environment: 'test', provider_idempotency_key: `idem-${uuidv7()}`, status: 'pending',
    amount_cents: open.total_gross_cents, currency: open.currency } });
  assert.equal((await deliver(paidEvent(open, { amount: 100 }))).status, 200);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: open.id } })).payment_state, 'review');
  const audit = await db.auditEvent.findFirst({ where: { target_ref: open.id, action: 'payment.unmatched' } });
  assert.equal(audit.after_safe.reason, 'amount_mismatch');

  const paid = await makeOrder('paid');
  assert.equal((await deliver(paidEvent(paid, { amount: 100 }))).status, 200);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: paid.id } })).payment_state, 'paid');
});

test('a completed session without a booked payment is not billed twice', async () => {
  const order = await makeOrder('awaiting');
  const sessionId = `cs_test_${uuidv7()}`;
  await db.paymentAttempt.create({ data: { id: uuidv7(), order_id: order.id, provider: 'stripe',
    environment: 'test', provider_session_id: sessionId, provider_idempotency_key: `idem-${uuidv7()}`,
    status: 'pending', amount_cents: order.total_gross_cents, currency: order.currency } });
  // The customer finished the form, the payment is still on its way (SEPA).
  stripe.sessions.set(sessionId, { id: sessionId, status: 'complete', url: null });

  const owner = await db.user.findUniqueOrThrow({ where: { id: order.user_id } });
  const payments = stripeService();
  await assert.rejects(payments.startSession(order.id, owner.email_original),
    error => error.getStatus?.() === 409 && error.getResponse?.().code === 'PAYMENT_IN_PROGRESS');
  assert.equal(await db.paymentAttempt.count({ where: { order_id: order.id } }), 1,
    'no second attempt, therefore no second payment');


  // An *expired* session may be replaced: nothing was paid in it.
  stripe.sessions.set(sessionId, { id: sessionId, status: 'expired' });
  const fresh = await payments.startSession(order.id, owner.email_original);
  assert.ok(fresh.url);
  // One open attempt per order (`payment_attempts_one_open`): the old one is
  // cancelled, the new one created — never two open rows.
  assert.equal(await db.paymentAttempt.count({ where: { order_id: order.id,
    status: { in: ['created', 'pending'] } } }), 1);
  assert.equal(await db.paymentAttempt.count({ where: { order_id: order.id } }), 2);
  const superseded = await db.paymentAttempt.findFirst({ where: { order_id: order.id,
    status: 'cancelled' } });
  assert.equal(superseded.failure_code, 'superseded');
});

test('the session is created in the currency of the order', async () => {
  const order = await makeOrder('awaiting');
  const owner = await db.user.findUniqueOrThrow({ where: { id: order.user_id } });
  const payments = stripeService();
  const result = await payments.startSession(order.id, owner.email_original);
  assert.ok(result.url);
  // The stub records what would have been sent to Stripe.
  const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { order_id: order.id },
    orderBy: { created_at: 'desc' } });
  assert.equal(attempt.currency, 'EUR');
});

test('foreign references are acknowledged only after verification; oversized payloads are identified', async () => {
  const event = paidEvent({ id: 'other-app', total_gross_cents: 19900n });
  delete event.data.object.metadata;
  const url = '/api/v1/payments/stripe/webhook';
  const invalid = await request(server).post(url).set('Stripe-Signature', 'invalid').send(event);
  assert.equal(invalid.body.code, 'INVALID_SIGNATURE');
  assert.deepEqual((await deliver(event)).body, { received: true });
  assert.equal(await db.paymentEvent.count({ where: { provider_event_id: event.id } }), 0);
  assert.equal((await request(server).post(url).set('Content-Type','application/json').send('x'.repeat(262145))).status, 413);
});

test('untracked money goes to review; tracked money with missing items stays paid but blocked', async () => {
  for (const tracked of [false, true]) {
    const order = await makeOrder();
    const event = paidEvent(order);
    if (tracked) await db.paymentAttempt.create({ data: { id: uuidv7(), order_id: order.id, provider: 'stripe',
      environment: 'test', provider_session_id: event.data.object.id, provider_idempotency_key: uuidv7(),
      status: 'pending', amount_cents: order.total_gross_cents, currency: order.currency } });
    for (const res of await Promise.all([deliver(event), deliver(event)])) assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(after.payment_state, tracked ? 'paid' : 'review');
    if (tracked) assert.equal(after.fulfillment_state, 'blocked');
    assert.equal(await db.paymentEvent.count({ where: { order_id: order.id } }), 1);
    assert.equal(await db.courseAccess.count({ where: { order_id: order.id } }), 0);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { target_ref: order.id, action: tracked ? 'fulfilment.needs_review' : 'payment.unmatched' } });
    assert.equal(audit.after_safe.reason, tracked ? 'FULFILMENT_INCOMPLETE' : 'payment_not_tracked');
  }
});

test('concurrent checkout starts reuse a durable attempt and identical provider idempotency key', async () => {
  const order = await makeOrder(), payments = stripeService();
  const keys = new Set();
  payments.client.checkout.sessions.create = async (payload, options) => {
    keys.add(options.idempotencyKey);
    const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { id: payload.metadata.attempt_id } });
    assert.equal(attempt.provider_idempotency_key, options.idempotencyKey);
    // Emulate Stripe returning the same session for the same key.
    const session = { id: `cs_${attempt.id}`, status: 'open', url: `https://stripe.test/pay/${attempt.id}` };
    stripe.sessions.set(session.id, session); return session;
  };
  const [first, second] = await Promise.all([1,2].map(() => payments.startSession(order.id, order.buyer_email_original)));
  assert.deepEqual(first, second);
  assert.equal(keys.size, 1);
  assert.equal(await db.paymentAttempt.count({ where: { order_id: order.id } }), 1);
});
