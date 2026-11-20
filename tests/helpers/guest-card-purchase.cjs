// Used only inside isolated destructive integration fixtures. The only simulated service is hosted Stripe.
const assert = require('node:assert/strict'),
  request = require('supertest'),
  { uuidv7 } = require('uuidv7');
const { MailWorker } = require('../../apps/api/dist/mail-worker');
const { unseal } = require('../../apps/api/dist/security');
const origin = 'https://academy.test';
const status = (response, expected) => assert.equal(response.status, expected, JSON.stringify(response.body));
async function exerciseGuestCard({ app, db, server, Browser, product, body, email }) {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.equal(process.env.APP_ENV, 'test');
  const { StripePayments } = require('../../apps/api/dist/stripe');
  const service = app.get(StripePayments);
  const real = service.client,
    sessions = new Map(),
    guest = new Browser(),
    visitor = new Browser();
  const dbReader = new (require('pg').Client)({ connectionString: process.env.DATABASE_URL });
  const { inspectPurchase, verifyRemote } = await import('../../scripts/check-staging-purchase.mjs');
  let session;
  service.client = {
    webhooks: real.webhooks,
    checkout: {
      sessions: {
        create: async (payload) => {
          assert.match(payload.success_url, /\?gast=1&status=pruefung$/);
          assert.match(payload.cancel_url, /\?gast=1&status=abgebrochen$/);
          const id = 'cs_test_' + uuidv7();
          session = {
            id,
            object: 'checkout.session',
            livemode: false,
            mode: 'payment',
            payment_status: 'unpaid',
            status: 'open',
            currency: 'eur',
            amount_total: payload.line_items[0].price_data.unit_amount,
            payment_intent: 'pi_' + uuidv7(),
            client_reference_id: payload.client_reference_id,
            metadata: payload.metadata,
            url: 'https://example.invalid/hosted-checkout',
          };
          sessions.set(id, session);
          return session;
        },
        retrieve: async (id) => sessions.get(id),
      },
    },
  };
  try {
    await dbReader.connect();
    status(await guest.change('post', '/guest/cart/items', { product_id: product.id }), 200);
    status(await guest.change('post', '/guest/email/verify/request', { email }), 202);
    const proof = await db.emailOutbox.findFirstOrThrow({
      where: { to_email: email, template_version: { template: { key: 'checkout_email_verify' } } },
      orderBy: { created_at: 'desc' },
    });
    const { token } = unseal(proof.variables_secret_ciphertext, `outbox:${proof.id}`, proof.secret_key_id);
    status(await guest.change('post', '/guest/email/verify/confirm', { token }), 200);
    const placed = await guest.change('post', '/guest/orders', body);
    status(placed, 201);
    const id = placed.body.id,
      pay = '/guest/orders/' + id + '/pay',
      invoice = placed.body.invoice;
    assert.equal(invoice.seller.bank, null);
    assert.equal(invoice.payment_reference, null);
    assert.equal(invoice.pdf_href, null);
    const mail = await db.emailOutbox.findFirstOrThrow({
      where: { to_email: email, template_version: { template: { key: 'card_order_placed' } } },
    });
    const messages = [],
      job = await db.automationJob.findFirstOrThrow({ where: { ref_id: mail.id, kind: 'email.send' } });
    const worker = new MailWorker(db, {
      sendMail: async (m) => {
        messages.push(m);
        return { accepted: [m.to], messageId: m.messageId };
      },
    });
    assert.equal(await worker.runOne(job.id), true);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Kartenzahlung/);
    status(await visitor.change('post', pay, {}), 404);
    assert.equal(sessions.size, 0);
    status(
      await request(server)
        .post('/api/v1' + pay)
        .set('Cookie', guest.cookie())
        .set('Origin', origin)
        .send({}),
      403,
    );
    const opened = await guest.change('post', pay, {});
    status(opened, 200);
    assert.equal(opened.body.url, session.url);
    status(await guest.change('post', pay, {}), 200);
    assert.equal(sessions.size, 1);
    assert.equal(await inspectPurchase(dbReader, id), undefined);
    assert.equal(await db.courseAccess.count({ where: { order_id: id } }), 0);
    Object.assign(session, { status: 'complete', payment_status: 'paid', url: null });
    const event = {
      id: 'evt_' + uuidv7(),
      livemode: false,
      type: 'checkout.session.completed',
      data: { object: session },
    };
    const payload = JSON.stringify(event),
      sig = real.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    for (let n = 0; n < 2; n++)
      status(
        await request(server)
          .post('/api/v1/payments/stripe/webhook')
          .set('Content-Type', 'application/json')
          .set('Stripe-Signature', sig)
          .send(payload),
        200,
      );
    verifyRemote(await inspectPurchase(dbReader, id), event, session);
    assert.equal(await db.paymentEvent.count({ where: { order_id: id } }), 1);
    assert.equal(await db.invoice.count({ where: { order_id: id } }), 1);
    const paid = (await guest.get('/guest/orders/' + id)).body;
    assert.equal(paid.fulfillment_state, 'fulfilled');
    status(await guest.get(paid.invoice.pdf_href), 200);
    status(await visitor.get(paid.invoice.pdf_href), 404);
    status(await guest.change('post', pay, {}), 409);
    return id;
  } finally {
    service.client = real;
    await dbReader.end();
  }
}
module.exports = { exerciseGuestCard };
