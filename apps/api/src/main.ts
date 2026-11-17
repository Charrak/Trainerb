import { createApplication } from './application';

async function main() {
  const app = await createApplication();
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT || 4000), '0.0.0.0');
  console.log('API für Kursentwürfe und Freigaben gestartet. Verkauf, Checkout und Zahlungen sind deaktiviert.');
}
main().catch(() => { console.error('API konnte nicht gestartet werden. Pflichtkonfiguration und Abhängigkeiten prüfen.'); process.exitCode = 1; });
