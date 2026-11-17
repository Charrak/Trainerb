import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import nodemailer from 'nodemailer';
import { Database } from './database';
import { getConfig } from './config';
import { MailWorker } from './mail-worker';
import { dispatchDueMail } from './mail-dispatcher';

async function main() {
  const config = getConfig();
  if (!config.smtpHost) throw new Error('SMTP_HOST is required to start the mail worker.');
  const db = new Database();
  const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
    ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPassword || '' } } : {}) });
  const mailer = new MailWorker(db, { sendMail: message => transport.sendMail(message) });
  const queueConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const workerConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  queueConnection.on('error', () => {}); workerConnection.on('error', () => {});
  const queue = new Queue('mail', { connection: queueConnection, prefix: 'trainerb' });
  const consumer = new Worker<{ job_id: string }>('mail', async job => { await mailer.runOne(job.data.job_id); },
    { connection: workerConnection, prefix: 'trainerb', concurrency: 4 });
  consumer.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'mail_queue_connection_failed' })));
  consumer.on('failed', () => console.error(JSON.stringify({ level: 'error', event: 'mail_queue_job_failed' })));
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  await db.$connect();
  console.log('Mail-Worker gestartet; PostgreSQL-Aufträge werden über BullMQ abgearbeitet.');
  let lastPurge = 0;
  try {
    while (!stopping) {
      try {
        if (Date.now() - lastPurge > 60_000) { await mailer.purgeExpiredSecrets(); lastPurge = Date.now(); }
        await dispatchDueMail(db, jobId => queue.add('email.send', { job_id: jobId }, {
          jobId, removeOnComplete: true, removeOnFail: true,
        }));
        await delay(2_000);
      } catch {
        console.error(JSON.stringify({ level: 'error', event: 'mail_dispatcher_temporary_failure' }));
        await delay(5_000);
      }
    }
  } finally {
    await consumer.close(); await queue.close(); queueConnection.disconnect(); workerConnection.disconnect();
    transport.close(); await db.$disconnect();
  }
}
main().catch(() => { console.error('Mail-Worker konnte nicht gestartet werden. Konfiguration prüfen.'); process.exitCode = 1; });
