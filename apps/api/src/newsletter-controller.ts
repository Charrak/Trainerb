import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { RateLimiter } from './limiter';
import { Outbox } from './outbox';
import { backofficeWrite } from './backoffice-write';
import { apiError, bodyObject, normalizeEmail, randomToken, requireUuid } from './security';
import { plainText } from './commerce-validation';
import {
  policy,
  unavailable,
  invalid,
  expired,
  tokenHash,
  parseLeave,
  leaveToken,
  lockSubscriber,
  endGrant,
  audit,
  sendingEnabled,
} from './newsletter';
const received = { received: true };
@Controller()
export class NewsletterController {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
    private readonly limiter: RateLimiter,
    private readonly outbox: Outbox,
  ) {}
  @Get('newsletter/policy') async info() {
    const p = await policy(this.db);
    return p ? { wording: p.wording, policy: p.policy } : null;
  }
  private ip(req: ApiRequest) {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }
  @Post('newsletter/subscribe') @HttpCode(202) async subscribe(@Req() req: ApiRequest, @Body() input: unknown) {
    await this.sessions.verifyCsrf(req);
    await this.limiter.hit('newsletter-sub-ip', this.ip(req), 12, 3600000);
    const b = bodyObject(input, ['email', 'policy', 'topic', 'accepted']);
    const { canonical } = normalizeEmail(b.email);
    if (b.accepted !== true || (b.topic !== 'kurse' && b.topic !== 'akademie')) throw invalid();
    const topic = b.topic;
    await this.limiter.hit('newsletter-sub-email', canonical, 3, 3600000);
    return this.db.$transaction(async (tx) => {
      const p = await policy(tx);
      if (!p || b.policy !== p.policy) throw unavailable();
      await tx.newsletterSubscriber.createMany({ data: [{ id: uuidv7(), email: canonical }], skipDuplicates: true });
      const [s] = await tx.$queryRaw<
        { id: string; status: string; topic: string | null; policy: string | null }[]
      >`SELECT id,status,topic,policy FROM newsletter_subscribers WHERE email=${canonical} FOR UPDATE`;
      if (
        ['bounced', 'complained'].includes(s.status) ||
        (s.status === 'confirmed' && s.topic === topic && s.policy === p.policy)
      )
        return received;
      const token = randomToken(),
        data = { ...p, topic, token_hash: tokenHash(token), expires_at: new Date(Date.now() + 30 * 60000) };
      await tx.newsletterProof.upsert({
        where: { subscriber_id: s.id },
        create: { subscriber_id: s.id, ...data },
        update: data,
      });
      await this.outbox.notifyGuestCoded(tx, canonical, '', 'newsletter_confirm', {}, token, {
        purpose: 'newsletter_confirm',
      });
      return received;
    });
  }
  @Post('newsletter/confirm') @HttpCode(200) async confirm(@Req() req: ApiRequest, @Body() input: unknown) {
    await this.sessions.verifyCsrf(req);
    await this.limiter.hit('newsletter-confirm-ip', this.ip(req), 60);
    const { token } = bodyObject(input, ['token']);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw expired();
    const token_hash = tokenHash(token);
    return this.db.$transaction(async (tx) => {
      const candidate = await tx.newsletterProof.findUnique({ where: { token_hash }, select: { subscriber_id: true } });
      if (!candidate) throw expired();
      const s = await lockSubscriber(tx, candidate.subscriber_id),
        p = await tx.newsletterProof.findUnique({ where: { token_hash } });
      if (
        !p ||
        p.expires_at <= new Date() ||
        ['bounced', 'complained'].includes(s.status) ||
        p.policy !== (await policy(tx))?.policy
      )
        throw expired();
      if (s.epoch) await endGrant(tx, s.epoch, 'withdraw');
      const epoch = uuidv7();
      await tx.newsletterConsentEvent.create({
        data: {
          id: uuidv7(),
          subscriber_id: s.id,
          epoch,
          action: 'grant',
          policy: p.policy,
          topic: p.topic,
          wording: p.wording,
          privacy_id: p.privacy_id,
        },
      });
      await tx.newsletterSubscriber.update({
        where: { id: s.id },
        data: { status: 'confirmed', epoch, topic: p.topic, policy: p.policy },
      });
      await tx.newsletterProof.delete({ where: { subscriber_id: s.id } });
      return { unsubscribe_token: leaveToken(s.id, epoch) };
    });
  }
  private async leave(token: unknown) {
    const { id, epoch } = parseLeave(token);
    return this.db.$transaction(async (tx) => {
      const s = await lockSubscriber(tx, id);
      if (s.epoch === epoch) {
        await endGrant(tx, epoch, 'withdraw');
        await tx.newsletterSubscriber.update({
          where: { id },
          data: { status: 'unsubscribed', epoch: null, policy: null, topic: null },
        });
        await tx.newsletterProof.deleteMany({ where: { subscriber_id: id } });
      }
      return received;
    });
  }
  @Post('newsletter/unsubscribe') @HttpCode(200) async unsubscribe(@Req() req: ApiRequest, @Body() input: unknown) {
    await this.sessions.verifyCsrf(req);
    await this.limiter.hit('newsletter-leave-ip', this.ip(req), 60);
    return this.leave(bodyObject(input, ['token']).token);
  }
  @Post('newsletter/one-click/:token') @HttpCode(200) async oneClick(
    @Req() req: ApiRequest,
    @Param('token') token: string,
    @Body() body: unknown,
  ) {
    await this.limiter.hit('newsletter-one-click-ip', this.ip(req), 300);
    if (
      !req.is('application/x-www-form-urlencoded') ||
      bodyObject(body, ['List-Unsubscribe'])['List-Unsubscribe'] !== 'One-Click'
    )
      throw invalid();
    return this.leave(token);
  }
  /**
   * Reichweite je Segment, ohne Adressen zu zeigen. Die Zahl zählt bestätigte
   * Einwilligungen mit gültiger Fassung; "aktive Lernende" verlangt zusätzlich
   * einen bestehenden Kurszugang.
   */
  @Get('admin/newsletter/audiences') async audiences(@Req() req: ApiRequest) {
    await this.sessions.require(req, { backoffice: true, permission: 'newsletter.read' });
    const p = await policy(this.db);
    if (!p) return { available: false, data: [] };
    const [row] = await this.db.$queryRaw<{ all: number; kurse: number; akademie: number; kurse_aktiv: number }[]>`
      SELECT count(*)::int AS all,count(*) FILTER(WHERE s.topic='kurse')::int AS kurse,
        count(*) FILTER(WHERE s.topic='akademie')::int AS akademie,
        count(*) FILTER(WHERE s.topic='kurse' AND EXISTS(
          SELECT 1 FROM users u JOIN course_access a ON a.user_id=u.id
          WHERE u.email_canonical=s.email AND u.deleted_at IS NULL AND u.status='active'
            AND a.revoked_at IS NULL AND a.suspended_at IS NULL AND a.starts_at<=now()
            AND (a.ends_at IS NULL OR a.ends_at>now())))::int AS kurse_aktiv
      FROM newsletter_subscribers s WHERE s.status='confirmed' AND s.policy=${p.policy}`;
    return { available: true, data: [
      { key: 'all', size: row.all }, { key: 'kurse', size: row.kurse },
      { key: 'akademie', size: row.akademie }, { key: 'kurse_aktiv', size: row.kurse_aktiv },
    ] };
  }
  @Get('admin/newsletter/campaigns') async list(@Req() req: ApiRequest) {
    await this.sessions.require(req, { backoffice: true, permission: 'newsletter.read' });
    const rows = await this.db.$queryRaw<
      {
        id: string;
        subject: string;
        body: string;
        audience: string;
        status: string;
        scheduled_at: Date | null;
        total: number;
        accepted: number;
        suppressed: number;
        failed: number;
      }[]
    >`WITH latest AS (SELECT * FROM newsletter_campaigns ORDER BY created_at DESC,id DESC LIMIT 50)
   SELECT c.id,c.subject,c.body,c.audience,c.status,c.scheduled_at,c.audience_size,s.* FROM latest c CROSS JOIN LATERAL (SELECT count(*)::int AS total,
    count(*) FILTER(WHERE o.status='accepted')::int AS accepted,count(*) FILTER(WHERE o.status='suppressed' OR(c.status='cancelled' AND n.dispatched_at IS NULL))::int AS suppressed,
    count(*) FILTER(WHERE o.status='failed' OR(n.outbox_id IS NULL AND n.dispatched_at IS NOT NULL))::int AS failed FROM newsletter_sends n LEFT JOIN email_outbox o ON o.id=n.outbox_id WHERE n.campaign_id=c.id)s ORDER BY c.created_at DESC,c.id DESC`;
    return { enabled: sendingEnabled(), data: rows };
  }
  @Post('admin/newsletter/campaigns') create(@Req() req: ApiRequest, @Body() input: unknown) {
    return backofficeWrite(this.db, this.sessions, req, 'newsletter.edit', async (tx, actor) => {
      const b = bodyObject(input, ['subject', 'body', 'audience']);
      if (!['all', 'kurse', 'akademie', 'kurse_aktiv'].includes(String(b.audience)) || typeof b.audience !== 'string') throw invalid();
      const id = uuidv7();
      await tx.newsletterCampaign.create({
        data: {
          id,
          created_by: actor,
          subject: plainText(b.subject, 'subject', 160)!,
          body: plainText(b.body, 'body', 12000, false, true)!,
          audience: b.audience,
        },
      });
      await audit(tx, actor, 'drafted', id);
      return { id };
    });
  }
  @Post('admin/newsletter/campaigns/:id/schedule') @HttpCode(200) schedule(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, 'newsletter.send', async (tx, actor) => {
      const b = bodyObject(input, ['scheduled_at']);
      if (typeof b.scheduled_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b.scheduled_at))
        throw invalid();
      const at = new Date(b.scheduled_at);
      if (
        !Number.isFinite(at.getTime()) ||
        at.toISOString() !== b.scheduled_at ||
        at.getTime() < Date.now() - 60000 ||
        at.getTime() > Date.now() + 366 * 86400000
      )
        throw invalid();
      const p = await policy(tx);
      if (!p || !sendingEnabled()) throw unavailable();
      const r = await tx.newsletterCampaign.updateMany({
        where: { id: requireUuid(id), status: 'draft' },
        data: { status: 'scheduled', policy: p.policy, scheduled_at: at, approved_by: actor },
      });
      if (!r.count) throw apiError(409, 'CAMPAIGN_CHANGED', 'Bitte den Kampagnenstand neu laden.');
      await audit(tx, actor, 'scheduled', id);
      return received;
    });
  }
  /**
   * Anhalten und Fortsetzen nur vor dem Einfrieren: sobald der Empfängerkreis
   * festgelegt ist, darf ein Lauf nur noch gestoppt, nicht wiederbelebt werden.
   */
  @Post('admin/newsletter/campaigns/:id/pause') @HttpCode(200) pause(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, 'newsletter.send', async (tx, actor) => {
      bodyObject(input, []);
      const r = await tx.newsletterCampaign.updateMany({
        where: { id: requireUuid(id), status: 'scheduled' },
        data: { status: 'paused' },
      });
      if (!r.count) throw apiError(409, 'CAMPAIGN_CHANGED', 'Bitte den Kampagnenstand neu laden.');
      await audit(tx, actor, 'paused', id);
      return received;
    });
  }
  @Post('admin/newsletter/campaigns/:id/resume') @HttpCode(200) resume(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, 'newsletter.send', async (tx, actor) => {
      bodyObject(input, []);
      const r = await tx.newsletterCampaign.updateMany({
        where: { id: requireUuid(id), status: 'paused' },
        data: { status: 'scheduled' },
      });
      if (!r.count) throw apiError(409, 'CAMPAIGN_CHANGED', 'Bitte den Kampagnenstand neu laden.');
      await audit(tx, actor, 'resumed', id);
      return received;
    });
  }
  @Post('admin/newsletter/campaigns/:id/cancel') @HttpCode(200) cancel(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, 'newsletter.send', async (tx, actor) => {
      bodyObject(input, []);
      const r = await tx.newsletterCampaign.updateMany({
        where: { id: requireUuid(id), status: { not: 'cancelled' } },
        data: { status: 'cancelled' },
      });
      if (!r.count) throw apiError(409, 'CAMPAIGN_CHANGED', 'Bitte neu laden.');
      await audit(tx, actor, 'cancelled', id);
      return received;
    });
  }
  @Post('admin/newsletter/suppress') @HttpCode(200) suppress(@Req() req: ApiRequest, @Body() input: unknown) {
    return backofficeWrite(this.db, this.sessions, req, 'newsletter.send', async (tx, actor) => {
      const b = bodyObject(input, ['email', 'reason']),
        { canonical } = normalizeEmail(b.email);
      if (b.reason !== 'bounced' && b.reason !== 'complained') throw invalid();
      const reason = b.reason;
      await tx.newsletterSubscriber.createMany({
        data: [{ id: uuidv7(), email: canonical, status: reason }],
        skipDuplicates: true,
      });
      const [s] = await tx.$queryRaw<
        { id: string; epoch: string | null; status: string }[]
      >`SELECT id,epoch,status FROM newsletter_subscribers WHERE email=${canonical} FOR UPDATE`;
      if (s.epoch) await endGrant(tx, s.epoch, reason);
      await tx.newsletterSubscriber.update({
        where: { id: s.id },
        data: { status: s.status === 'complained' ? s.status : reason, epoch: null, topic: null, policy: null },
      });
      await tx.newsletterProof.deleteMany({ where: { subscriber_id: s.id } });
      await audit(tx, actor, 'suppressed', s.id);
      return received;
    });
  }
}
