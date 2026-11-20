import 'reflect-metadata';
import { createInterface } from 'node:readline/promises';
import * as OTPAuth from 'otpauth';
import { Database } from '../database';
import { replaceLostFactor } from '../offline-mfa';
import { requireUuid } from '../security';
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length !== 2)
    throw Error('Private terminal required.');
  const tty = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
  const db = new Database();
  process.stdout.write('\x1b[?1049h');
  try {
    const incident = await tty.question('Extern freigegebene Vorgangsnummer (IR-JJJJ-NNNN): ');
    if (!/^IR-[0-9]{4}-[0-9]{4,10}$/.test(incident)) throw Error('Invalid ticket.');
    const target = requireUuid(await tty.question('Geprüfte Konto-ID: '));
    const old = await db.userMfaFactor.findFirstOrThrow({
      where: { user_id: target, type: 'totp', status: 'active' },
      select: { id: true },
    });
    if (
      (await tty.question(
        'Identität, Zielkonto und Vier-Augen-Freigabe extern geprüft? Zum Fortfahren Vorgangsnummer erneut eingeben: ',
      )) !== incident
    )
      throw Error('Aborted.');
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    console.log('Nur auf dem verifizierten Gerät als TOTP (SHA1, 6 Stellen, 30 Sekunden) einrichten:', secret);
    const code = await tty.question('Aktueller Code des neuen Geräts: ');
    const codes = await replaceLostFactor(db, target, old.id, incident, secret, code);
    console.log('Faktor ersetzt. Neue Einmalcodes getrennt und sicher verwahren:\n' + codes.join('\n'));
    await tty.question('Nach sicherer Übernahme Eingabetaste drücken.');
  } finally {
    tty.close();
    process.stdout.write('\x1b[2J\x1b[H\x1b[?1049l');
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error('Offline-Wiederherstellung nicht regulär abgeschlossen. Auditstand prüfen.');
  process.exitCode = 1;
});
