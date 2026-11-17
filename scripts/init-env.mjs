import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

if (process.env.APP_ENV === 'production') throw new Error('Local development configuration cannot be initialized in production.');
const path = '.env';
if (!existsSync(path)) writeFileSync(path, readFileSync('.env.example', 'utf8'), { flag: 'wx', mode: 0o600 });
let contents = readFileSync(path, 'utf8');
if (/^\s*APP_ENV\s*=\s*production\s*$/m.test(contents)) throw new Error('Refusing to change a production .env.');
let generated = 0;
for (const name of ['SESSION_HMAC_KEY', 'CSRF_HMAC_KEY', 'TOKEN_HMAC_KEY', 'DATA_ENCRYPTION_KEY', 'AUDIT_PSEUDONYMIZATION_KEY']) {
  const line = new RegExp(`^${name}=(.*)$`, 'm');
  const match = contents.match(line);
  if (!match) throw new Error(`Missing ${name}= line in .env; add it before running this script.`);
  if (!match[1].trim()) { contents = contents.replace(line, `${name}=${randomBytes(32).toString('base64')}`); generated++; }
}
writeFileSync(path, contents, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`Lokale .env eingerichtet; ${generated} fehlende Schlüssel ergänzt. Vorhandene Schlüssel wurden nicht ersetzt.`);
