const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptsEditorialJson } = require('../../apps/api/dist/json-body');

test('Nur POST auf die drei Redaktions-Schreibrouten erhält das größere JSON-Limit', () => {
  const id = '01234567-1234-4123-abcd-123456789abc';
  for (const path of ['admin/commerce/legal','admin/pages',`admin/pages/${id}/drafts/`]) {
    assert.equal(acceptsEditorialJson('POST','/api/v1/'+path),true);
    for (const method of ['GET','PUT','PATCH','DELETE']) assert.equal(acceptsEditorialJson(method,'/api/v1/'+path),false);
  }
  for (const path of ['pages','admin/pages-other','admin/pages/invalid/drafts',`admin/pages/${id}/publish`,
    `admin/pages/${id}/withdraw`,`admin/pages/${id}/drafts/other`,`admin/commerce/legal/${id}/activate`,
    'admin/commerce/settings','payments/stripe/webhook','auth/login']) assert.equal(acceptsEditorialJson('POST','/api/v1/'+path),false);
});
