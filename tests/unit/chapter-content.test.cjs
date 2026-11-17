const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contentDocument, supportedContentDocument } = require('../../apps/api/dist/chapter-content');

const id = '01890f2a-7bcd-7f01-8abc-123456789abc';
const block = input => contentDocument(input, id).blocks[0];

test('lesson blocks have a stable ID, strict shape and text rather than executable HTML', () => {
  assert.deepEqual(block({ kind: 'paragraph', text: '  Text <script>test</script>\nZeile  ' }),
    { id, kind: 'paragraph', text: 'Text <script>test</script>\nZeile' });
  assert.deepEqual(block({ kind: 'heading', text: ' Kapitel ', level: 3 }), { id, kind: 'heading', text: 'Kapitel', level: 3 });
  assert.deepEqual(block({ kind: 'list', items: [' Eins ', 'Zwei'] }), { id, kind: 'list', items: ['Eins', 'Zwei'] });
  for (const invalid of [
    { kind: 'paragraph', text: '\u200b' }, { kind: 'paragraph', text: '\ud800' },
    { kind: 'heading', level: 1, text: 'Text' }, { kind: 'list', items: [] },
    { kind: 'list', items: Array(31).fill('Eintrag') }, { kind: 'list', items: ['A\nB'] },
    { kind: 'paragraph', text: 'Text', arbitrary: 'unknown' }, { kind: 'image', text: 'Bild' },
  ]) assert.throws(() => contentDocument(invalid, id));
});

test('links allow only normalized HTTPS URLs or same-origin absolute paths', () => {
  assert.equal(block({ kind: 'link', text: 'Extern', href: 'https://example.org' }).href, 'https://example.org/');
  assert.equal(block({ kind: 'link', text: 'Intern', href: '/kurse?art=test#abschnitt' }).href, '/kurse?art=test#abschnitt');
  for (const href of ['http://example.org', 'javascript:alert(1)', 'data:text/html,test', '//evil.invalid',
    '/\\evil.invalid', 'https://user:pass@evil.invalid', 'https://example.org/a b', 'https://example.org/\nmalicious', 'relative/path']) {
    assert.throws(() => block({ kind: 'link', text: 'Link', href }), href);
  }
});

test('future or malformed documents are not editable by this version', () => {
  const valid = contentDocument({ kind: 'paragraph', text: 'Text' }, id);
  assert.equal(supportedContentDocument(valid, id), true);
  assert.equal(supportedContentDocument({ ...valid, future: true }, id), false);
  assert.equal(supportedContentDocument({ schema_version: 2, blocks: valid.blocks }, id), false);
  assert.equal(supportedContentDocument({ schema_version: 1, blocks: [{ id, kind: 'paragraph', text: 'Text', extra: 'keep' }] }, id), false);
  assert.equal(supportedContentDocument(valid, 'different-id'), false);
  assert.equal(supportedContentDocument(null, id), false);
});
