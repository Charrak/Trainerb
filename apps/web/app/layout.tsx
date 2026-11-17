import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trainer B Akademie – Entwicklungsversion',
  description: 'Entwicklungsversion der Online-Akademie mit Kontozugang und Kursentwürfen.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de" data-scroll-behavior="smooth"><body><a href="#inhalt" className="skip-link">Zum Inhalt springen</a>{children}</body></html>;
}
