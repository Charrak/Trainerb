import {expiryMessage} from './expiry-notices';
import {campaignMessage,policy,tokenHash} from './newsletter';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { getConfig } from './config';
import { keyedHash, normalizeEmail, unseal } from './security';

/** SMTP may accept a message before a process dies. A stable Message-ID helps
 * reconciliation, but SMTP itself does not guarantee exactly-once delivery. */
export interface MailMessage {
  from: string; to: string; subject: string; text: string; messageId: string; headers?: Record<string,string>;
}
export interface MailTransport {
  sendMail(message: MailMessage): Promise<{ accepted?: unknown[]; messageId?: string }>;
}

type Claim = { jobId: string; outboxId: string | null; attempt: number; startedAt: Date };
const LEASE_MS = 120_000;

export class MailWorker {
  constructor(private readonly db: Database, private readonly transport: MailTransport) {}

  private async claim(jobId?: string): Promise<Claim | 'handled' | null> {
    return this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM automation_jobs
        WHERE kind = 'email.send' AND ref_type = 'email_outbox'
          AND (${jobId || null}::uuid IS NULL OR id = ${jobId || null}::uuid)
          AND ((status = 'queued' AND run_after <= now()) OR (status = 'running' AND lease_until <= now()))
        ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows.length) return null;
      const job = await tx.automationJob.findUniqueOrThrow({ where: { id: rows[0].id } });
      const now = new Date();
      if (job.status === 'running' && job.attempts > 0) {
        // An expired lease may have died before OR after SMTP acceptance.
        await tx.automationJobAttempt.createMany({ data: [{ id: uuidv7(), automation_job_id: job.id,
          attempt_no: job.attempts, started_at: job.updated_at, finished_at: now,
          result: 'failed', error_safe: 'LEASE_EXPIRED_DELIVERY_OUTCOME_UNKNOWN' }], skipDuplicates: true });
      }
      if (job.attempts >= job.max_attempts) {
        await tx.automationJob.update({ where: { id: job.id }, data: { status: 'failed', lease_until: null,
          finished_at: now, last_error_safe: 'MAX_ATTEMPTS_REACHED' } });
        if (job.ref_id) await tx.emailOutbox.updateMany({ where: { id: job.ref_id, status: { in: ['queued', 'sending'] } },
          data: { status: 'failed', last_error_safe: 'MAX_ATTEMPTS_REACHED' } });
        return 'handled';
      }
      const attempt = job.attempts + 1;
      await tx.automationJob.update({ where: { id: job.id }, data: { status: 'running', attempts: attempt,
        lease_until: new Date(now.getTime() + LEASE_MS), last_error_safe: null } });
      if (job.ref_id) await tx.emailOutbox.updateMany({ where: { id: job.ref_id, status: { in: ['queued', 'sending'] } },
        data: { status: 'sending', attempts: { increment: 1 }, last_error_safe: null } });
      return { jobId: job.id, outboxId: job.ref_id, attempt, startedAt: now };
    });
  }

  private async finish(claim: Claim, result: 'succeeded' | 'failed' | 'cancelled', safeError?: string, messageId?: string) {
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM automation_jobs WHERE id = ${claim.jobId}::uuid FOR UPDATE`;
      const job = await tx.automationJob.findUnique({ where: { id: claim.jobId } });
      // If a lease was reclaimed, the other attempt owns the job now.
      if (!job || job.status !== 'running' || job.attempts !== claim.attempt) return;
      const now = new Date();
      await tx.automationJobAttempt.create({ data: { id: uuidv7(), automation_job_id: job.id, attempt_no: claim.attempt,
        started_at: claim.startedAt, finished_at: now, result, error_safe: safeError } });
      const exhausted = result === 'failed' && job.attempts >= job.max_attempts;
      const status = result === 'succeeded' ? 'succeeded' : result === 'cancelled' ? 'cancelled' : exhausted ? 'failed' : 'queued';
      const delayMs = Math.min(30 * 60_000, 10_000 * 2 ** Math.min(job.attempts - 1, 8));
      await tx.automationJob.update({ where: { id: job.id }, data: { status, lease_until: null,
        run_after: status === 'queued' ? new Date(now.getTime() + delayMs) : job.run_after,
        finished_at: status === 'queued' ? null : now, last_error_safe: safeError || null } });
      if (claim.outboxId) {
        const data: Prisma.EmailOutboxUpdateManyMutationInput = result === 'succeeded'
          ? { status: 'accepted', sent_at: now, provider: 'smtp', provider_message_id: messageId || null,
              variables_secret_ciphertext: null, secret_key_id: null, secret_delete_after: null, last_error_safe: null }
          : result === 'cancelled'
            ? { status: 'suppressed', variables_secret_ciphertext: null, secret_key_id: null, secret_delete_after: null, last_error_safe: safeError }
            : { status: exhausted ? 'failed' : 'queued', last_error_safe: safeError };
        await tx.emailOutbox.updateMany({ where: { id: claim.outboxId, status: 'sending' }, data });
      }
    });
  }

  private render(template: string, variables: Record<string, string>): string {
    const result = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_whole, key: string) => {
      if (!Object.hasOwn(variables, key)) throw new Error('Unknown template variable.');
      return variables[key];
    });
    if (result.includes('{{') || result.includes('}}')) throw new Error('Invalid template.');
    return result;
  }

  private async message(outboxId: string): Promise<MailMessage | null> {
    const item = await this.db.emailOutbox.findUnique({ where: { id: outboxId },
      include: { user: true, template_version: { include: { template: true } } } });
    // Guest mails have no account yet; they are addressed to the proven address.
    if (!item || item.status !== 'sending') return null;
    if (item.user && !['pending_activation', 'active'].includes(item.user.status)) return null;
    if (!item.user && item.template_version.template.key !== 'checkout_email_verify' &&
        !['newsletter_confirm','newsletter_campaign','order_placed', 'card_order_placed', 'order_paid', 'refund_confirmed',
          'withdrawal_received', 'withdrawal_decided', 'withdrawal_verify'].includes(item.template_version.template.key)) return null;
    const publicVars = item.variables_public;
    if (!publicVars || typeof publicVars !== 'object' || Array.isArray(publicVars) || typeof publicVars.first_name !== 'string') {
      throw new Error('Invalid template variables.');
    }
    const variables: Record<string, string> = { first_name: publicVars.first_name };
    const key = item.template_version.template.key;
    const purposes = { activation: 'activation_url', password_reset: 'reset_url', email_change: 'email_change_url' } as const;
    let headers:Record<string,string>|undefined;
    if ((item.purpose==='newsletter') !== (key==='newsletter_campaign'))return null;
    if(key==='course_expiry'){
      const n=await expiryMessage(this.db,item.id,item.to_email);if(!n)return null;variables.course_title=n.title;variables.ends_at=n.ends_at;
    } else if(key==='newsletter_campaign'){
      const c=await campaignMessage(this.db,item.id,item.to_email);if(!c)return null;
      variables.subject=c.subject;variables.body=c.body;variables.leave_url=`${getConfig().publicBaseUrl}/newsletter/abmelden#token=${c.leave_token}`;
      headers={'List-Unsubscribe':`<${getConfig().publicBaseUrl}/api/v1/newsletter/one-click/${c.leave_token}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'};
    } else if(key==='newsletter_confirm'){
      if(!item.variables_secret_ciphertext||!item.secret_key_id||!item.secret_delete_after||item.secret_delete_after<=new Date())return null;
      const p=unseal<{token:string;purpose:string}>(item.variables_secret_ciphertext,`outbox:${item.id}`,item.secret_key_id);
      if(p.purpose!=='newsletter_confirm')return null;
      const proof=await this.db.newsletterProof.findUnique({where:{token_hash:tokenHash(p.token)}});
      if(!proof||proof.expires_at<=new Date()||proof.policy!==(await policy(this.db))?.policy)return null;
      if(!await this.db.newsletterSubscriber.count({where:{id:proof.subscriber_id,email:item.to_email,status:{notIn:['complained','bounced']}}}))return null;
      variables.wording=proof.wording;variables.topic=proof.topic==='kurse'?'Kurse':'Akademie';variables.confirm_url=`${getConfig().publicBaseUrl}/newsletter/bestaetigen#token=${p.token}`;
    } else if (key in purposes) {
      if (!item.user) return null;
      if (!item.variables_secret_ciphertext || !item.secret_key_id || !item.secret_delete_after || item.secret_delete_after <= new Date()) return null;
      const payload = unseal<{ token: string; purpose: string }>(item.variables_secret_ciphertext, `outbox:${item.id}`, item.secret_key_id);
      if (payload.purpose !== key || !/^[A-Za-z0-9_-]{43}$/.test(payload.token)) throw new Error('Invalid secret payload.');
      const token = await this.db.accountToken.findUnique({ where: { token_hash: keyedHash(getConfig().tokenKey, 'account-token', payload.token) } });
      if (!token || token.user_id !== item.user_id || token.purpose !== key || token.used_at || token.revoked_at || token.expires_at <= new Date()) return null;
      if ((key === 'activation' && item.user.status !== 'pending_activation') ||
          (key !== 'activation' && item.user.status !== 'active')) return null;
      const to = normalizeEmail(item.to_email).canonical;
      if (to !== (key === 'email_change' ? token.target_email_canonical : item.user.email_canonical)) return null;
      const path = key === 'activation' ? '/konto/aktivieren' : key === 'password_reset' ? '/konto/passwort-zuruecksetzen' : '/konto/email-bestaetigen';
      variables[purposes[key as keyof typeof purposes]] = `${getConfig().publicBaseUrl}${path}#token=${encodeURIComponent(payload.token)}`;
    } else if (['order_placed', 'card_order_placed', 'order_paid', 'refund_confirmed'].includes(key)) {
      // Order mails only carry order facts that are already public to the buyer.
      const names = key === 'refund_confirmed'
        ? ['order_number', 'total', 'credit_note_number'] : key === 'card_order_placed' ? ['order_number','total'] : ['order_number', 'total', 'payment_reference'];
      for (const name of names) {
        const value = publicVars[name];
        if (typeof value !== 'string' || !/^[A-Za-z0-9 .,:€/-]{1,64}$/.test(value)) throw new Error('Invalid template variables.');
        variables[name] = value;
      }
    } else if (key === 'withdrawal_verify') {
      // The link is built here from the sealed token, never stored in clear.
      if (!item.variables_secret_ciphertext || !item.secret_key_id || !item.secret_delete_after ||
          item.secret_delete_after <= new Date()) return null;
      const payload = unseal<{ token: string; purpose: string }>(item.variables_secret_ciphertext,
        `outbox:${item.id}`, item.secret_key_id);
      if (payload.purpose !== 'withdrawal' || !/^[A-Za-z0-9_-]{43}$/.test(payload.token)) {
        throw new Error('Invalid secret payload.');
      }
      const proof = await this.db.withdrawalVerification.findUnique({
        where: { token_hash: keyedHash(getConfig().tokenKey, 'withdrawal-verify', payload.token) } });
      if (!proof || proof.consumed_at || proof.verified_at || proof.expires_at <= new Date()) return null;
      variables.verification_url = `${getConfig().publicBaseUrl}/widerruf/bestaetigen#token=${encodeURIComponent(payload.token)}`;
    } else if (key === 'withdrawal_received') {
      // The receipt is the proof of the deadline, so its timestamp is the one
      // stored at submission — not the time the mail happened to be sent.
      for (const name of ['received_date', 'received_time']) {
        const value = publicVars[name];
        if (typeof value !== 'string' || !/^[0-9.:]{4,5}$/.test(value)) throw new Error('Invalid template variables.');
        variables[name] = value;
      }
    } else if (key === 'withdrawal_decided') {
      const decision = publicVars.decision;
      if (decision !== 'angenommen' && decision !== 'abgelehnt') throw new Error('Invalid template variables.');
      variables.decision = decision;
    } else if (key === 'checkout_email_verify') {
      // Guest checkout proof: the six-digit code is public, the link token is
      // sealed. A proof that already expired or was consumed is not re-sent —
      // the buyer has to request a fresh one, exactly like an expired link.
      const code = publicVars.code;
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('Invalid template variables.');
      if (!item.variables_secret_ciphertext || !item.secret_key_id || !item.secret_delete_after ||
          item.secret_delete_after <= new Date()) return null;
      const payload = unseal<{ token: string; purpose: string }>(item.variables_secret_ciphertext, `outbox:${item.id}`, item.secret_key_id);
      if (payload.purpose !== key || !/^[A-Za-z0-9_-]{43}$/.test(payload.token)) throw new Error('Invalid secret payload.');
      variables.code = code;
      variables.verify_url = `${getConfig().publicBaseUrl}/kasse/bestaetigen#token=${encodeURIComponent(payload.token)}`;
    } else if (key === 'dispute_opened') {
      // Internal notice: money facts only. The order number and the reason are
      // checked like every other public variable so a manual case cannot smuggle
      // free text (or an address) into a staff inbox.
      for (const name of ['order_number', 'amount', 'reason', 'status']) {
        const value = publicVars[name];
        if (typeof value !== 'string' || !/^[A-Za-z0-9 .,:_/-]{1,64}$/.test(value)) {
          throw new Error('Invalid template variables.');
        }
        variables[name] = value;
      }
    } else if (!['password_changed', 'email_changed_old','certificate_ready'].includes(key)) {
      throw new Error('Unsupported mail template.');
    }
    const subject = this.render(item.template_version.subject_template, variables);
    if (/[\r\n]/.test(subject)) throw new Error('Invalid subject.');
    return { headers, from: getConfig().mailFrom, to: item.to_email, subject,
      text: this.render(item.template_version.body_text_template, variables),
      messageId: `<trainerb-${item.id}@mail.invalid>` };
  }

  /** Purge expired encrypted tokens even when their jobs previously failed. */
  async purgeExpiredSecrets(): Promise<void> {
    await this.db.emailOutbox.updateMany({ where: { secret_delete_after: { lte: new Date() } },
      data: { variables_secret_ciphertext: null, secret_key_id: null, secret_delete_after: null } });
  }

  /** Process a specific durable job, or one due job during reconciliation. */
  async runOne(jobId?: string): Promise<boolean> {
    const claim = await this.claim(jobId);
    if (!claim) return false;
    if (claim === 'handled') return true;
    let transportStarted = false;
    try {
      const message = claim.outboxId ? await this.message(claim.outboxId) : null;
      if (!message) { await this.finish(claim, 'cancelled', 'MAIL_NO_LONGER_ELIGIBLE'); return true; }
      transportStarted = true;
      const info = await this.transport.sendMail(message);
      if (!Array.isArray(info.accepted) || info.accepted.length !== 1) throw new Error('Recipient not accepted.');
      await this.finish(claim, 'succeeded', undefined, info.messageId || message.messageId);
    } catch {
      // Never store a transport exception, recipient, content or a token in logs.
      await this.finish(claim, 'failed', transportStarted ? 'MAIL_DELIVERY_FAILED' : 'MAIL_PREPARATION_FAILED');
    }
    return true;
  }
}
