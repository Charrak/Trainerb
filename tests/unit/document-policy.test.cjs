const {test} = require('node:test');
const assert = require('node:assert/strict');
require('ts-node').register({transpileOnly:true, compilerOptions:{module:'CommonJS',moduleResolution:'Node'}});
const {documentPolicy} = require('../../apps/web/lib/document-policy.ts');
const parse = env => Object.fromEntries(documentPolicy(env).split('; ').map(d => {const [key,...v]=d.split(' ');return [key,v];}));
test('Produktive Dokumente erhalten unterschiedliche Nonces und eng begrenzte Quellen',()=>{
  const env={NODE_ENV:'production', APP_ENV:'development', TRAINERB_EMBEDDED_PREVIEW_COOKIES:'true', MEDIA_S3_ENDPOINT:'https://media.example.invalid'};
  const a=parse(env),b=parse(env);
  assert.deepEqual(a['frame-ancestors'],["'none'"]); assert.deepEqual(a['script-src-attr'],["'none'"]);
  assert.equal(a['script-src'].length,2);assert.equal(a['script-src'][0],"'self'");assert.match(a['script-src'][1],/^'nonce-[\w+/]{32}'$/);
  assert.notEqual(a['script-src'][1],b['script-src'][1]);assert.deepEqual(a['connect-src'],["'self'"]);
  for (const d of ['img-src','media-src']) assert.ok(a[d].includes(env.MEDIA_S3_ENDPOINT));
  for (const src of ['https://*.example.invalid','https://name@media.example.invalid','https://media.example.invalid/bucket','http://media.example.invalid','data:'])
    assert.throws(()=>documentPolicy({...env, MEDIA_S3_ENDPOINT:src}));
});
test('Einbettung ist nur als explizite Entwicklungsvorschau für eine HTTPS-Origin erlaubt',()=>{
  const env={NODE_ENV:'development',APP_ENV:'development',PREVIEW_FRAME_ORIGIN:'https://parent.example.invalid'};
  assert.deepEqual(parse({...env,PREVIEW_FRAME_ORIGIN:'',TRAINERB_EMBEDDED_PREVIEW_COOKIES:'true'})['frame-ancestors'],["'none'"]);
  assert.deepEqual(parse(env)['frame-ancestors'],["'none'"]);
  assert.deepEqual(parse({...env,TRAINERB_EMBEDDED_PREVIEW_COOKIES:'true'})['frame-ancestors'],[env.PREVIEW_FRAME_ORIGIN]);
  assert.deepEqual(parse({...env,APP_ENV:'production',TRAINERB_EMBEDDED_PREVIEW_COOKIES:'true'})['frame-ancestors'],["'none'"]);
});
