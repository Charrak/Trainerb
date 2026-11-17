import 'reflect-metadata';
import { Database } from '../database';
import { seedCatalog } from './catalog';

async function main() {
  const db = new Database();
  try { await db.$connect(); await seedCatalog(db); console.log('Rollen, Rechte und transaktionale Mailvorlagen sind eingerichtet.'); }
  finally { await db.$disconnect(); }
}
main().catch(() => { console.error('Einrichtung fehlgeschlagen. Konfiguration und Datenbank prüfen.'); process.exitCode = 1; });
