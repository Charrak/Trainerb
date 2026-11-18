import type { Metadata } from 'next';
import './globals.css';
import { liveSite } from '../lib/site-stage';

export const metadata: Metadata = {
  title: liveSite ? 'Trainer B Akademie' : 'Trainer B Akademie – Entwicklungsversion',
  description: 'Online-Akademie mit Kurskatalog und persönlichem Lernbereich.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de" data-scroll-behavior="smooth"><body><a href="#inhalt" className="skip-link">Zum Inhalt springen</a>{children}</body></html>;
}
