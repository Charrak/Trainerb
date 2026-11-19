import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export type CertificateSnapshot = {
  heading: string;
  issuer: string;
  first_name: string;
  last_name: string;
  title: string;
  version: number;
  completed_on: string;
  number: string;
  verification_url: string;
  token: string;
};

/** Fixed local layout. Operator input is only text; no HTML, external assets or scripts. */
export async function certificatePdf(s: CertificateSnapshot) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')), {
    subset: true,
  });
  const page = pdf.addPage([842, 595]);
  const glyphs = new Set(font.getCharacterSet());
  page.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderWidth: 1, borderColor: rgb(0.15, 0.35, 0.37) });
  let y = 515;
  const line = (text: string, size: number, gap: number) => {
    // Do not issue a document that silently substitutes missing glyphs or clips a long name.
    if (Array.from(text).some((c) => !glyphs.has(c.codePointAt(0)!))) throw new Error('UNSUPPORTED_CERTIFICATE_TEXT');
    let part = '';
    const draw = () => {
      if (y < 40) throw new Error('CERTIFICATE_LAYOUT_OVERFLOW');
      page.drawText(part, { font, size, x: (842 - font.widthOfTextAtSize(part, size)) / 2, y });
      y -= size * 1.3;
      part = '';
    };
    for (const c of text) {
      if (font.widthOfTextAtSize(part + c, size) > 730) draw();
      part += c;
    }
    draw();
    y -= gap;
  };
  line(s.issuer, 13, 10);
  line(s.heading, 26, 13);
  line(`${s.first_name} ${s.last_name}`, 22, 10);
  line(s.title, 18, 6);
  line(`Kursversion ${s.version} · Abschluss am ${s.completed_on}`, 13, 10);
  line(`Zertifikatsnummer: ${s.number}`, 11, 8);
  line(s.verification_url, 11, 2);
  line(`Prüfcode: ${s.token}`, 11, 0);
  pdf.setTitle(s.heading);
  return Buffer.from(await pdf.save());
}
