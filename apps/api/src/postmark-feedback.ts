import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import type { ApiRequest } from './sessions';
import { apiError, normalizeEmail } from './security';
import { endGrant } from './newsletter';
/** Independent per-environment credentials. A partial configuration cannot turn feedback on. */
export function postmarkSettings() {
  const {
    POSTMARK_FEEDBACK_PASSWORD: password,
    POSTMARK_SERVER_ID: server,
    POSTMARK_BROADCAST_STREAM: stream,
  } = process.env;
  if (!password && !server && !stream) return null;
  if (
    !password ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(password) ||
    !server ||
    !/^\d{1,15}$/.test(server) ||
    !stream ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(stream)
  )
    throw Error('Incomplete Postmark settings');
  return { password, server, stream };
}
const hash = (s: string) => createHash('sha256').update(s).digest();
@Controller('newsletter/feedback')
export class PostmarkFeedback {
  constructor(private readonly db: Database) {}
  @Post('postmark') @HttpCode(200) async accept(@Req() req: ApiRequest) {
    const cfg = postmarkSettings();
    if (!cfg) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
    const actual = req.get('authorization') ?? '',
      expected = 'Basic ' + Buffer.from('trainerb:' + cfg.password).toString('base64');
    if (!timingSafeEqual(hash(actual), hash(expected)))
      throw apiError(401, 'FEEDBACK_UNAUTHORIZED', 'Nicht autorisiert.');
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw apiError(400, 'INVALID_FEEDBACK', 'Ungültige Meldung.');
    const ok = { received: true };
    const kind =
      b.RecordType === 'SpamComplaint' || (b.RecordType === 'Bounce' && b.Type === 'SpamComplaint')
        ? 'complained'
        : b.RecordType === 'Bounce' && b.Type === 'HardBounce'
          ? 'bounced'
          : null;
    // Shared Postmark accounts may also carry transactional and non-terminal events.
    if (!kind || String(b.ServerID) !== cfg.server || b.MessageStream !== cfg.stream) return ok;
    const outbox = b.Metadata?.trainerb_outbox;
    if (
      typeof outbox !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(outbox)
    )
      return ok;
    if (!Number.isSafeInteger(b.ID) || b.ID <= 0) throw apiError(400, 'INVALID_FEEDBACK', 'Ungültige Ereignis-ID.');
    const event_id = String(b.ID);
    const { canonical } = normalizeEmail(b.Email);
    return this.db.$transaction(async (tx) => {
      const [s] = await tx.$queryRaw<
        { id: string; status: string; epoch: string | null }[]
      >`SELECT s.id,s.status,s.epoch FROM newsletter_sends n JOIN newsletter_subscribers s ON s.id=n.subscriber_id JOIN email_outbox o ON o.id=n.outbox_id
 WHERE n.outbox_id=${outbox}::uuid AND o.purpose='newsletter' AND o.to_email=${canonical} AND s.email=${canonical} AND o.attempts>0 FOR UPDATE OF s`;
      if (!s) return ok;
      const saved = await tx.newsletterFeedback.createMany({
        data: [{ event_id, kind, server_id: cfg.server, send_outbox_id: outbox }],
        skipDuplicates: true,
      });
      if (!saved.count) return ok;
      if (s.epoch) await endGrant(tx, s.epoch, kind);
      await tx.newsletterSubscriber.update({
        where: { id: s.id },
        data: { status: s.status === 'complained' ? s.status : kind, epoch: null, topic: null, policy: null },
      });
      await tx.newsletterProof.deleteMany({ where: { subscriber_id: s.id } });
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          origin: 'provider',
          action: 'newsletter.suppressed',
          target_type: 'newsletter',
          target_ref: s.id,
          after_safe: { reason: kind },
        },
      });
      return ok;
    });
  }
}
