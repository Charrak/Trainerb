/** Read-only evidence for ONE synthetic guest order. Never creates/replays provider events. */
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import Stripe from 'stripe';

const refuse = () => { throw new Error('Staging evidence incomplete'); };
export function settings(env) {
  if (env.STAGING_READ_ONLY_CHECK !== 'yes' || env.APP_ENV === 'production' || env.NODE_ENV === 'production' ||
      !/^(?:rk|sk)_test_[A-Za-z0-9_]+$/.test(env.STAGING_STRIPE_TEST_KEY ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.STAGING_ORDER_ID??'')) refuse();
  const url = new URL(env.STAGING_READONLY_DATABASE_URL);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !/^\/[a-z0-9_]+_(?:staging|test)$/.test(url.pathname) ||
      url.search || url.hash) refuse();
  return {url,order:env.STAGING_ORDER_ID,key:env.STAGING_STRIPE_TEST_KEY};
}
export async function inspectPurchase(db, order) {
  // No raw address, invoice snapshot, session token or document is selected. One consistent snapshot.
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const {rows}=await db.query(`SELECT o.id,o.currency,o.total_gross_cents::text AS amount,
      a.id AS attempt,a.provider_payment_id AS intent,a.provider_session_id AS session,
      e.provider_event_id AS event,e.event_type AS type
      FROM orders o JOIN payment_attempts a ON a.order_id=o.id AND a.provider='stripe' AND a.environment='test'
        AND a.status='succeeded' AND a.amount_cents=o.total_gross_cents AND a.currency=o.currency
      JOIN checkout_email_verifications proof ON proof.id=o.checkout_email_verification_id AND proof.verified_at IS NOT NULL AND proof.consumed_at IS NOT NULL
      JOIN invoices i ON i.order_id=o.id AND i.total_gross_cents=o.total_gross_cents AND i.currency=o.currency
      JOIN payment_events e ON e.order_id=o.id AND e.provider='stripe' AND e.environment='test' AND e.amount_cents=a.amount_cents AND e.currency=a.currency
        AND e.event_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded')
      WHERE o.id=$1 AND o.identity_kind='guest' AND o.payment_method='stripe' AND o.payment_state='paid' AND o.paid_via='provider'
        AND o.fulfillment_state='fulfilled' AND o.user_id IS NOT NULL
        AND (SELECT count(*) FROM payment_attempts WHERE order_id=o.id AND status='succeeded')=1
        AND EXISTS(SELECT FROM order_item_courses WHERE order_id=o.id)
        AND NOT EXISTS(SELECT FROM order_item_courses t WHERE t.order_id=o.id AND 1<>(SELECT count(*) FROM course_access g WHERE g.order_id=o.id
          AND g.source='order' AND g.user_id=o.user_id AND g.course_version_id=t.course_version_id AND g.course_id=t.course_id
          AND g.suspended_at IS NULL AND g.revoked_at IS NULL))
        AND NOT EXISTS(SELECT FROM course_access g WHERE g.order_id=o.id AND (g.user_id<>o.user_id OR NOT EXISTS(
          SELECT FROM order_item_courses t WHERE t.order_id=o.id AND t.course_version_id=g.course_version_id AND t.course_id=g.course_id)))
      ORDER BY e.received_at DESC LIMIT 1`,[order]);
    await db.query('COMMIT');return rows[0];
  } catch(e){await db.query('ROLLBACK');throw e;}
}
export function verifyRemote(row,event,session){
  const matches = s => s && s.object==='checkout.session' && s.livemode===false && s.id===row.session && s.status==='complete' && s.payment_status==='paid' &&
    s.mode==='payment' && s.metadata?.order_id===row.id && s.metadata?.attempt_id===row.attempt && s.client_reference_id===row.id &&
    s.payment_intent===row.intent && Number.isSafeInteger(s.amount_total) && String(s.amount_total)===row.amount && s.currency?.toUpperCase()===row.currency;
  if(!row || !row.intent || !row.session?.startsWith('cs_test_') || event?.livemode!==false || event.id!==row.event || event.type!==row.type ||
      !matches(event.data?.object) || !matches(session))refuse();
}
async function main(){
  const {url,key,order}=settings(process.env);
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const db=new Client({connectionString:url.href,ssl:local?undefined:{rejectUnauthorized:true},connectionTimeoutMillis:5000,statement_timeout:10000});
  await db.connect();let row;try{row=await inspectPurchase(db,order);}finally{await db.end();}
  if(!row?.event?.startsWith('evt_')||!row.session?.startsWith('cs_test_'))refuse();
  const client=new Stripe(key,{timeout:10000,maxNetworkRetries:1});
  verifyRemote(row,await client.events.retrieve(row.event),await client.checkout.sessions.retrieve(row.session));
  console.log('Staging-Abgleich erfolgreich: Testanbieter-Ereignis und Sitzung passen zu Gastbestellung, Rechnung, Zahlung und Kurszugängen.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Staging-Abgleich fehlgeschlagen. Umgebung, Berechtigungen, Anbieterereignis und Bestellstand prüfen.');process.exitCode=1;});
