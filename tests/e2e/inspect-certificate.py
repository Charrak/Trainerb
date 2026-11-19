"""Read only the downloaded synthetic PDF. Never print raw document text to logs."""
import re
import sys
import pymupdf

with pymupdf.open(sys.argv[1]) as doc:
    assert len(doc) == 1, 'Expected one certificate page'
    page = doc[0]
    text = page.get_text()
    name = 'Élodie-Luise Friederike Antonia Groß-Schönfeld von Winterstein-Hohenweide'
    # A long name may wrap, but characters must not be lost or turned into replacement glyphs.
    assert ''.join(name.split()) in ''.join(text.split()), 'Participant name missing or truncated'
    for field in ['Testurkunde', 'Synthetischer Aussteller',
                  'Entwurf abschluss-fixture', 'Kursversion 1', sys.argv[2], 'https://academy.test/zertifikat-pruefen']:
        assert field in text, 'Missing expected certificate field'
    assert re.search(r'Abschluss am \d{4}-\d\d-\d\d', text), 'Missing date'
    for block in page.get_text('blocks'):
        assert page.rect.contains(pymupdf.Rect(block[:4])), 'Text extends past page edge'
    assert page.get_pixmap().width > 0, 'PDF is not renderable'
    match = re.search(r'Prüfcode: ([A-Za-z0-9_-]{43})(?:\s|$)', text)
    assert match, 'Missing readable verification code'
    # Captured through a private pipe by the browser test, never included in its assertions.
    sys.stdout.write(match[1])
