import 'reflect-metadata';
import { uuidv7 } from 'uuidv7';
import { Database } from '../database';
import { Outbox } from '../outbox';
import { normalizeEmail, requireName } from '../security';

async function main() {
  // Validate everything before opening a transaction or creating any record.
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const firstName = requireName(process.env.BOOTSTRAP_ADMIN_FIRST_NAME, 'first_name');
  const lastName = requireName(process.env.BOOTSTRAP_ADMIN_LAST_NAME, 'last_name');
  const db = new Database(); const outbox = new Outbox();
  try {
    await db.$connect();
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('trainerb_first_superadmin'))::text`;
      const marker = await tx.auditEvent.findFirst({ where: { action: 'bootstrap.superadmin_created', origin: 'bootstrap' } });
      if (marker) {
        const bootstrapped = await tx.user.findUnique({ where: { id: marker.target_ref }, include: { roles: { include: { role: true } } } });
        if (bootstrapped?.email_canonical === email.canonical && bootstrapped.first_name === firstName &&
            bootstrapped.last_name === lastName && bootstrapped.roles.some(item => item.role.key === 'superadmin')) return 'already';
        throw new Error('Superadmin bootstrap already completed; no unattended second bootstrap is allowed.');
      }
      if (await tx.userRole.findFirst({ where: { role: { key: 'superadmin' } } })) {
        throw new Error('A superadmin already exists; no unattended bootstrap is allowed.');
      }
      if (await tx.user.findUnique({ where: { email_canonical: email.canonical } })) throw new Error('Bootstrap address already belongs to an account.');
      const participant = await tx.role.findUnique({ where: { key: 'participant' } });
      const superadmin = await tx.role.findUnique({ where: { key: 'superadmin' } });
      if (!participant || !superadmin) throw new Error('Run db:seed first.');
      const id = uuidv7();
      const user = await tx.user.create({ data: { id, email_original: email.original, email_canonical: email.canonical,
        first_name: firstName, last_name: lastName, status: 'pending_activation', locale: 'de-DE' } });
      await tx.userRole.createMany({ data: [
        { user_id: id, role_id: participant.id, granted_by: null },
        { user_id: id, role_id: superadmin.id, granted_by: null },
      ] });
      await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'bootstrap', action: 'bootstrap.superadmin_created', target_type: 'user', target_ref: id } });
      await outbox.issueToken(tx, user, 'activation');
      return 'created';
    });
    console.log(result === 'created' ? 'Erster Superadmin angelegt; Aktivierung ist zur Zustellung vorgemerkt.' : 'Bootstrap wurde bereits für dieses Konto ausgeführt.');
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error('Bootstrap abgebrochen. Pflichtangaben, Konfiguration, Rollen und bestehenden Superadmin prüfen.'); process.exitCode = 1; });
