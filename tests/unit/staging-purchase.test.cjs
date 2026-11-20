const test = require('node:test'),
  assert = require('node:assert/strict');
test('staging reconciliation refuses unsafe configuration and mismatches in either provider response', async () => {
  const { settings, verifyRemote } = await import('../../scripts/check-staging-purchase.mjs');
  const env = {
    STAGING_READ_ONLY_CHECK: 'yes',
    STAGING_READONLY_DATABASE_URL: 'postgresql://db/academy_staging',
    STAGING_ORDER_ID: '00000000-0000-4000-8000-000000000001',
    STAGING_STRIPE_TEST_KEY: 'rk_test_fixture',
  };
  settings(env);
  for (const bad of [
    { STAGING_READ_ONLY_CHECK: '' },
    { APP_ENV: 'production' },
    { NODE_ENV: 'production' },
    { STAGING_STRIPE_TEST_KEY: 'sk_live_fixture' },
    { STAGING_READONLY_DATABASE_URL: 'postgres://db/production' },
    { STAGING_READONLY_DATABASE_URL: 'postgres://db/academy_test?dbname=production' },
  ])
    assert.throws(() => settings({ ...env, ...bad }));
  const row = {
    id: 'order',
    attempt: 'attempt',
    session: 'cs_test_fixture',
    intent: 'pi_fixture',
    event: 'evt_fixture',
    type: 'checkout.session.completed',
    amount: '19900',
    currency: 'EUR',
  };
  const session = {
    id: row.session,
    object: 'checkout.session',
    livemode: false,
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 19900,
    currency: 'eur',
    payment_intent: row.intent,
    metadata: { order_id: row.id, attempt_id: row.attempt },
    client_reference_id: row.id,
  };
  const event = { id: row.event, livemode: false, type: row.type, data: { object: session } };
  verifyRemote(row, event, session);
  for (const changes of [
    { livemode: true },
    { amount_total: 19901 },
    { metadata: {} },
    { payment_intent: null },
    { currency: 'usd' },
    { status: 'open' },
  ]) {
    assert.throws(() => verifyRemote(row, event, { ...session, ...changes }));
    assert.throws(() => verifyRemote(row, { ...event, data: { object: { ...session, ...changes } } }, session));
  }
  assert.throws(() => verifyRemote(row, { ...event, id: 'different' }, session));
});
