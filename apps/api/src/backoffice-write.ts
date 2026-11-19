import type { Prisma } from '@prisma/client';
import type { Database } from './database';
import type { Sessions, ApiRequest, SessionContext } from './sessions';
import { apiError } from './security';

export async function backofficeWrite<T>(
  db: Database,
  sessions: Sessions,
  req: ApiRequest,
  permission: string,
  fn: (tx: Prisma.TransactionClient, actor: string) => Promise<T>,
) {
  const ctx = await sessions.require(req, { backoffice: true, fresh: true, permission });
  await sessions.verifyCsrf(req, ctx);
  return db.$transaction(async (tx) => {
    await assertBackofficeWrite(tx, sessions, ctx, permission);
    return fn(tx, ctx.user.id);
  });
}

export async function assertBackofficeWrite(
  tx: Prisma.TransactionClient,
  sessions: Sessions,
  ctx: SessionContext,
  permission: string,
) {
  await tx.$queryRaw`SELECT id FROM users WHERE id=${ctx.user.id}::uuid FOR UPDATE`;
  const session = await sessions.assertCurrent(tx, ctx);
  if (
    session.kind !== 'backoffice' ||
    !session.reauthenticated_at ||
    Date.now() - session.reauthenticated_at.getTime() > 300000 ||
    !(await tx.user.count({
      where: {
        id: ctx.user.id,
        status: 'active',
        roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } },
      },
    }))
  )
    throw apiError(403, 'FORBIDDEN', 'Bitte Berechtigung und Identitätsbestätigung prüfen.');
}
