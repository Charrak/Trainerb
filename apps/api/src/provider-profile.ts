import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { providerFields, type ProviderDetails, type ProviderField } from '@trainerb/contracts';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { apiError, bodyObject, normalizeEmail } from './security';
import { plainText } from './commerce-validation';
import { backofficeWrite } from './backoffice-write';

export async function lockProvider(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM provider_profile WHERE id=1 FOR UPDATE`;
  return tx.providerProfile.findUniqueOrThrow({ where: { id: 1 }, select: { revision: true, details: true } });
}
export const reviewRequired = () =>
  apiError(
    409,
    'IMPRINT_REVIEW_REQUIRED',
    'Bitte das aktuelle Anbieterprofil prüfen und eine passende Impressumsfassung freigeben.',
  );
const keys = Object.keys(providerFields) as ProviderField[];
function parse(input: unknown) {
  const fields = bodyObject(input, keys),
    result = {} as ProviderDetails;
  for (const key of keys) {
    const [, max, required] = providerFields[key];
    result[key] = plainText(fields[key], key, max, !required) ?? '';
  }
  result.country = result.country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(result.country))
    throw apiError(422, 'INVALID_COUNTRY', 'Bitte einen zweistelligen Ländercode angeben.');
  result.contact_email = normalizeEmail(result.contact_email).original;
  return result;
}
@Controller('admin/provider-profile')
export class ProviderProfileController {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
  ) {}
  @Get() async get(@Req() req: ApiRequest) {
    await this.sessions.require(req, { backoffice: true, permission: 'legal.manage' });
    return this.db.providerProfile.findUniqueOrThrow({ where: { id: 1 }, select: { revision: true, details: true } });
  }
  @Patch() save(@Req() req: ApiRequest, @Body() input: unknown) {
    return backofficeWrite(this.db, this.sessions, req, 'legal.manage', async (tx, actor) => {
      const b = bodyObject(input, ['revision', 'details']),
        details = parse(b.details);
      const old = await lockProvider(tx);
      if (b.revision !== old.revision)
        throw apiError(409, 'PROFILE_CHANGED', 'Anbieterprofil zwischenzeitlich geändert. Bitte neu laden.');
      if (old.details && keys.every((k) => (old.details as Prisma.JsonObject)[k] === details[k])) return old;
      const next = await tx.providerProfile.update({
        where: { id: 1 },
        data: { revision: { increment: 1 }, details },
        select: { revision: true, details: true },
      });
      const paused = await tx.commerceSettings.updateMany({
        where: { sales_enabled: true },
        data: { sales_enabled: false },
      });
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          actor_user_id: actor,
          origin: 'user',
          action: 'provider_profile.updated',
          target_type: 'provider_profile',
          target_ref: '1',
          after_safe: { revision: next.revision, sales_paused: paused.count > 0 },
        },
      });
      return next;
    });
  }
}
