import { httpUrl } from '@trainerb/contracts';

/**
 * E-Mail-Fassungen: ein einziger, geprüfter HTML-Rahmen für jede Nachricht und
 * ein reiner Textteil. Es gibt keine Tabellen, keine externen Bilder, keine
 * Schriften, kein Tracking und keine vom Bearbeiter eingegebenen Webadressen.
 * Jeder Platzhalter wird kontextgerecht ausgegeben; ein Link entsteht nur aus
 * einer echten Webadresse (z. B. einem einmaligen Aktivierungslink).
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const placeholder = /\{\{ ?([a-z_]+) ?\}\}/g;
const linkPlaceholders = ['activation_url','reset_url','email_change_url','verify_url','verification_url','confirm_url','leave_url'] as const;

/** Füllt eine Vorlage und lehnt unbekannte Platzhalter sowie Restklammern ab. */
function fill(template: string, variables: Record<string, string>) {
  const used = new Set<string>();
  const text = template.replace(placeholder, (_whole, key: string) => {
    if (!Object.hasOwn(variables, key)) throw new Error('Unknown template variable.');
    used.add(key);
    return variables[key];
  });
  if (/[{}]/.test(text)) throw new Error('Invalid template.');
  return { text, used };
}

/**
 * Ein Link entsteht nur, wenn der Platzhalter in der Vorlage allein auf einer
 * Zeile steht und der eingesetzte Wert eine Webadresse ist. Die Position kommt
 * aus der Vorlage, nicht aus dem Wert.
 */
export function linkValues(template: string, variables: Record<string, string>): Set<string> {
  const values = new Set<string>();
  const lines = new Set(template.split('\n').map(line => line.trim()));
  for (const key of linkPlaceholders) {
    if (!lines.has(`{{${key}}}`) && !lines.has(`{{ ${key} }}`)) continue;
    const value = variables[key];
    if (value && httpUrl(value)) values.add(value);
  }
  return values;
}

function bodyHtml(body: string, links: Set<string>): string {
  return body
    .split(/\n{2,}/)
    .map(block => {
      const lines = block.split('\n').map(line => {
        const trimmed = line.trim();
        if (links.has(trimmed)) {
          return `<a href="${escapeHtml(trimmed).replace(/\r|\n/g, ' ')}" rel="noopener noreferrer">${escapeHtml(trimmed)}</a>`;
        }
        return escapeHtml(line);
      });
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('\n');
}

export interface MailFassungen {
  subject: string;
  text: string;
  html: string;
}

/**
 * Baut beide Fassungen aus der freigegebenen Klartextvorlage. Kopf- und
 * Fußzeile sind fest, damit jede Mail gleich aussieht und keine
 * Bearbeitereingabe als Markup wirkt.
 */
export function renderMailParts(
  subjectTemplate: string,
  textTemplate: string,
  variables: Record<string, string>,
): MailFassungen {
  const subject = fill(subjectTemplate, variables);
  if (/[\r\n]/.test(subject.text)) throw new Error('Invalid subject.');
  const body = fill(textTemplate, variables);
  const html = [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject.text)}</title>`,
    '<style>',
    'body{margin:0;padding:24px;background:#f0f4ee;color:#254b3c;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;}',
    '.rahmen{max-width:560px;margin:0 auto;background:#fff;border:1px solid #dfeadb;border-radius:8px;padding:24px;}',
    'p{margin:0 0 16px;}a{color:#2f5d3f;}h1{font-size:20px;line-height:1.3;margin:0 0 16px;}',
    '.kopf{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#526e4d;margin:0 0 20px;}',
    '.fuss{border-top:1px solid #dfeadb;margin-top:24px;padding-top:16px;font-size:13px;color:#526e4d;}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="rahmen">',
    '<p class="kopf">Trainer B Akademie</p>',
    `<h1>${escapeHtml(subject.text)}</h1>`,
    bodyHtml(body.text, linkValues(textTemplate, variables)),
    '<div class="fuss"><p>Diese Nachricht wurde automatisch erstellt. Antworten auf diese E-Mail werden nicht gelesen.</p></div>',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
  return { subject: subject.text, text: body.text, html };
}

/**
 * Feste, synthetische Beispieldaten für die Redaktionsvorschau. Keine echten
 * Adressen, Tokens oder Kontodaten; Links zeigen ausschließlich auf example.invalid.
 */
export const sampleValues: Record<string, string> = {
  first_name: 'Mila',
  course_title: 'Fitnesstrainer B-Lizenz',
  ends_at: '01.12.2026',
  order_number: 'TB-2026-0001',
  total: '1.900,00',
  payment_reference: 'TB-2026-0001',
  credit_note_number: 'TB-GS-2026-0001',
  received_date: '17.11.2026',
  received_time: '12:00',
  decision: 'angenommen',
  request_reference: 'ab12cd34',
  code: '000000',
  amount: '1.900,00',
  reason: 'Rückbuchung',
  status: 'offen',
  topic: 'Kurse',
  wording: 'Ich möchte den Newsletter der Akademie erhalten.',
  subject: 'Neues aus der Akademie',
  body: 'Ein kurzer Beispielabsatz.\n\nZweiter Absatz mit einem Satz zur Vorschau.',
  activation_url: 'https://example.invalid/konto/aktivieren#token=BEISPIEL',
  reset_url: 'https://example.invalid/konto/passwort-zuruecksetzen#token=BEISPIEL',
  email_change_url: 'https://example.invalid/konto/email-bestaetigen#token=BEISPIEL',
  verify_url: 'https://example.invalid/kasse/bestaetigen#token=BEISPIEL',
  verification_url: 'https://example.invalid/widerruf/bestaetigen#token=BEISPIEL',
  confirm_url: 'https://example.invalid/newsletter/bestaetigen#token=BEISPIEL',
  leave_url: 'https://example.invalid/newsletter/abmelden#token=BEISPIEL',
};
