import 'reflect-metadata';
import { Database } from '../database';
import { seedCatalog } from './catalog';
import { seedCommerce } from './commerce';

async function main() {
  const db = new Database();
  try { await db.$connect(); await seedCatalog(db); await seedCommerce(db);
    console.log('Rollen, Rechte, Mailvorlagen sowie Rechts- und Commerce-Grunddaten sind eingerichtet (Verkauf deaktiviert).'); }
  finally { await db.$disconnect(); }
}
main().catch(() => { console.error('Einrichtung fehlgeschlagen. Konfiguration und Datenbank prüfen.'); process.exitCode = 1; });
