const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../api/_lib/partner-engine.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', '"file:///affiliate-test/engine.js"');
const engine = vm.createContext({ process: { env: {} }, URL });
vm.runInContext(source, engine);

test('GetYourGuide uses explicit storefronts and keeps search intent and attribution', async () => {
  for (const [lang, store, intent] of [['en','en-gb','tickets'], ['es','es-es','entradas']]) {
    const result = await engine.resolvePublicResourceLink('getyourguide', lang);
    const contextual = engine.contextualSearchUrl('getyourguide', lang, lang,
      { entity_name: 'Blue Lagoon', need_type: 'ticket_required' }, 'Reykjavík');
    for (const target of [result.url, contextual]) {
      const url = new URL(target);
      assert.equal(url.pathname, `/${store}/s/`);
      assert.equal(url.searchParams.get('locale_autoredirect_optout'), 'true');
      assert.equal(engine.hasRequiredAttribution('getyourguide', target), true);
    }
    assert.match(new URL(contextual).searchParams.get('q'), new RegExp(`Blue Lagoon.*${intent}`));
  }
});

test('transport localization preserves the route, search and affiliate parameters', async () => {
  for (const [provider, url, en, es] of [
    ['12go', 'https://12go.asia/es/travel/bangkok/ayutthaya?z=1', '/en/travel/bangkok/ayutthaya', '/es/travel/bangkok/ayutthaya'],
    ['bookaway', 'https://www.bookaway.com/es/routes/spain/barcelona-to-madrid?aff_id=1', '/routes/spain/barcelona-to-madrid', '/es/routes/spain/barcelona-to-madrid']
  ]) {
    for (const [lang, expected] of [['en', en], ['es', es]]) {
      const target = new URL(engine.localizedTransportUrl(provider, url, lang));
      assert.equal(target.pathname, expected);
      assert.equal(target.search, new URL(url).search);
    }
  }
  assert.equal(new URL((await engine.resolvePublicResourceLink('bookaway','es')).url).pathname, '/es/');
  assert.equal(new URL((await engine.resolvePublicResourceLink('discovercars','es')).url).pathname, '/es');
  assert.equal(new URL((await engine.resolvePublicResourceLink('viator','es')).url).pathname, '/es-ES/');
  assert.equal(new URL((await engine.resolvePublicResourceLink('viator','en')).url).pathname, '/');
});
