const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Readable } = require('node:stream');

const campaignId = 'a1200000-0000-4000-8000-000000000000';
const participationId = 'a3200000-0000-4000-8000-000000000000';
const profileId = 'b0000000-0000-4000-8000-000000000000';
const sessionId = 'c0000000-0000-4000-8000-000000000000';
const testSecret = 'fixture-secret';
const env = {
  VERCEL_ENV: 'preview',
  SUPABASE_URL: 'https://fixture.supabase.invalid',
  SUPABASE_SECRET_KEY: 'fixture',
  ITBMO_INSTAGRAM_CAMPAIGN_ENABLED: 'true',
  ITBMO_INSTAGRAM_ACCOUNT_ID: '100',
  ITBMO_INSTAGRAM_ACCESS_TOKEN: 'fixture',
  ITBMO_INSTAGRAM_APP_SECRET: testSecret,
  ITBMO_INSTAGRAM_VERIFY_TOKEN: 'fixture-verification',
  ITBMO_INSTAGRAM_CLAIM_SECRET: 'fixture-signing-key-at-least-32-bytes',
  ITBMO_INSTAGRAM_LOGIN_MODE: 'instagram_login',
  ITBMO_INSTAGRAM_GRAPH_VERSION: 'v27.0',
  ITBMO_INSTAGRAM_CAMPAIGN_ORIGIN: 'https://preview.example.test'
};
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function response() {
  return {
    code: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    send(value) { this.value = value; return this; },
    end() { return this; }
  };
}

test('Instagram delivery respects scope, language, valid mentions, deduplication and signed claims', async (t) => {
  Object.assign(process.env, env);
  const { countMentions, instagramCampaignAction, instagramCampaignWebhook } = await import('../api/_lib/instagram-campaign.js');
  const { default: promotions } = await import('../api/promotions.js');
  const { routes } = require('../vercel.json');
  const messages = [];
  const graphRequests = [];
  const participants = new Map();
  let claimInput = null;
  let pricing = { regular_price_cents: 799, base_price_cents: 799, campaign_id: campaignId };
  let configured = true;
  let granted = 0;
  let status = 'active';
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    const body = init?.body && JSON.parse(init.body);
    if (['graph.instagram.com', 'graph.facebook.com'].includes(url.hostname)) {
      graphRequests.push({ host: url.hostname, path: url.pathname, body });
      if (init.method === 'POST') {
        messages.push(body);
        return json({ message_id: String(messages.length) });
      }
      throw new Error('Unexpected Instagram profile lookup');
    }
    if (url.pathname.endsWith('/instagram_campaign_reels')) {
      const media = url.searchParams.get('media_id');
      return json(['eq.42', 'eq.43'].includes(media) ? [{
        campaign_id: campaignId, language: media === 'eq.42' ? 'es' : 'en', test_keyword: 'PRUEBAITBMO'
      }] : []);
    }
    if (url.pathname.endsWith('/itbmo_current_offer')) {
      return json(pricing);
    }
    if (url.pathname.endsWith('/itbmo_offer_settings')) {
      return json(configured ? [{ campaign_id: campaignId }] : []);
    }
    if (url.pathname.endsWith('/instagram_campaign_settings')) {
      if (url.searchParams.get('select') === 'quota') return json([{ quota: 500 }]);
      return json([{ campaigns: {
        status, starts_at: new Date(Date.now() - 600_000).toISOString(),
        ends_at: new Date(Date.now() + 600_000).toISOString()
      } }]);
    }
    if (url.pathname.endsWith('/instagram_campaign_participation')) {
      if (url.searchParams.get('granted_at') === 'not.is.null') {
        assert.equal(url.searchParams.get('offset'), '499');
        assert.equal(url.searchParams.get('limit'), '1');
        return json(granted >= 500 ? [{ id: participationId }] : []);
      }
      if (init.method === 'POST') {
        const id = body.instagram_id === '20' ? participationId : `a3200000-0000-4000-8000-${body.instagram_id.padStart(12, '0')}`;
        if (!participants.has(body.instagram_id)) participants.set(body.instagram_id, { id, ...body });
        return json([]);
      }
      const row = url.searchParams.has('instagram_id') ?
        participants.get(url.searchParams.get('instagram_id').slice(3)) :
        [...participants.values()].find(entry => `eq.${entry.id}` === url.searchParams.get('id'));
      if (!row) return json([]);
      if (url.searchParams.get('user_id') === 'is.null' && row.user_id) return json([]);
      const expiryFilter = url.searchParams.get('link_expires_at');
      if (expiryFilter?.startsWith('gt.') &&
          !(Date.parse(row.link_expires_at) > Date.parse(expiryFilter.slice(3)))) return json([]);
      if (init.method === 'PATCH') Object.assign(row, body);
      return json([row]);
    }
    if (url.pathname.endsWith('/user_sessions')) return json([{
      id: sessionId, user_id: profileId, auth_level: 'supabase_auth'
    }]);
    if (url.pathname.endsWith('/itbmo_instagram_campaign_claim')) {
      claimInput = body;
      return json({ code: 'CLAIMED', expires_at: '2026-12-20T00:00:00Z' });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  async function deliver(entry, { secret = testSecret } = {}) {
    const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: '100', time: Date.now(), ...entry }] }));
    const req = Readable.from([body.subarray(0, 20), body.subarray(20)]);
    req.method = 'POST';
    req.headers = { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') };
    const res = response();
    await instagramCampaignWebhook(req, res);
    return res.code;
  }
  const comment = (text, media = '42', actor = '20', commentId = '50') => ({
    changes: [{ field: 'comments', value: { id: commentId, media: { id: media }, from: { id: actor, username: 'self' }, text } }]
  });
  const reply = (mid, text = 'CONFIRMAR', actor = '20') => ({
    messaging: [{ timestamp: Date.now(), sender: { id: actor }, recipient: { id: '100' }, message: { mid, text } }]
  });
  function claimLink(sent, commentId, language) {
    assert.deepEqual(sent.recipient, { comment_id: commentId });
    assert.deepEqual(Object.keys(sent.message), ['text']);
    const { text } = sent.message;
    assert.doesNotMatch(text, /CONFIRM|bot[oó]n|button/i);
    assert.match(text, language === 'es' ? /abre este enlace/i : /open this link/i);
    assert.match(text, /(?:sigue a|follow) @itravelbymyown/i);
    assert.match(text, language === 'es' ? /24 horas/ : /24 hours/);
    const lines = text.split('\n\n');
    assert.equal(lines.length, 2);
    const link = new URL(lines[1]);
    assert.equal(link.origin, env.ITBMO_INSTAGRAM_CAMPAIGN_ORIGIN);
    assert.equal(link.hash, '');
    assert.equal(link.search, '');
    assert.ok(link.pathname.startsWith(`/c/${language}/`));
    return link;
  }

  assert.equal(countMentions('@Friend, @friend, @self and not@test.com.', 'self'), 1);
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other'), { secret: 'wrong' }), 403);
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @friend.')), 200);
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '999')), 200);
  const beforeSend = Date.now();
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other')), 200);
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other')), 200);
  assert.equal(messages.length, 1);
  const link = claimLink(messages[0], '50', 'es');
  assert.equal(await deliver(reply('1')), 200);
  assert.equal(messages.length, 1);
  const route = routes.find(({ src }) => new RegExp(src).test(link.pathname));
  const destination = new URL(link.pathname.replace(new RegExp(route.src), route.dest), link.origin);
  const query = Object.fromEntries(destination.searchParams);
  const redirect = response();
  await promotions({ method: 'GET', query }, redirect);
  const token = query.token;
  assert.equal(redirect.code, 302);
  assert.equal(redirect.headers.Location, `/planner.html?lang=es#itbmo_campaign=${token}`);
  assert.equal(redirect.headers['Cache-Control'], 'no-store');
  assert.equal(redirect.headers['Referrer-Policy'], 'no-referrer');
  const malformedRedirect = response();
  await promotions({ method: 'GET', query: { ...query, token: '//example.test' } }, malformedRedirect);
  assert.equal(malformedRedirect.code, 404);
  const linkExpiry = Number(token.split('.')[1]);
  assert.ok(linkExpiry >= beforeSend + 86_400_000);
  assert.ok(linkExpiry <= Date.now() + 86_400_000);
  assert.equal(participants.get('20').link_expires_at, new Date(linkExpiry).toISOString());
  const claim = await instagramCampaignAction('instagram_claim', { token }, 'fixture-session');
  assert.equal(claim.ok, true);
  assert.equal(claimInput.p_user, profileId);
  assert.equal(claimInput.p_environment, 'preview');
  assert.equal(claimInput.p_participation, participationId);
  assert.equal((await instagramCampaignAction('instagram_claim', { token: token + 'x' }, 'fixture-session')).code, 'LINK_INVALID');
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '43', '20', '51')), 200);
  assert.equal(messages.length, 1);
  participants.set('30', {
    id: 'a3200000-0000-4000-8000-000000000030', instagram_id: '30', comment_id: '60', language: 'es',
    intro_sent_at: new Date().toISOString()
  });
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '42', '30', '60')), 200);
  assert.equal(messages.length, 1);
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '42', '30', '61')), 200);
  claimLink(messages[1], '61', 'es');
  assert.equal(participants.get('30').comment_id, '61');
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '43', '31', '62')), 200);
  claimLink(messages[2], '62', 'en');
  assert.ok(graphRequests.every(request => request.host === 'graph.instagram.com'));

  process.env.ITBMO_INSTAGRAM_LOGIN_MODE = 'unified_login';
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '43', '32', '63')), 200);
  const originalLink = claimLink(messages[3], '63', 'en').href;
  assert.deepEqual(graphRequests.at(-1), {
    host: 'graph.facebook.com',
    path: '/v27.0/100/messages',
    body: messages[3]
  });

  const english = participants.get('32');
  const originalExpiry = english.link_expires_at;
  const originalSentAt = english.link_sent_at;
  const recovery = reply('recovery-1', '  Itinerario  ', '32');
  assert.equal(await deliver(reply('missing-participation', 'ITINERARY', '99')), 200);
  const stale = reply('stale', 'ITINERARY', '32');
  stale.messaging[0].timestamp -= 24 * 3_600_000;
  assert.equal(await deliver(stale), 200);
  assert.equal(messages.length, 4);

  assert.equal(await deliver(recovery), 200);
  assert.equal(await deliver({ changes: [{ field: 'messages', value: recovery.messaging[0] }] }), 200);
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[4].recipient, { id: '32' });
  assert.match(messages[4].message.attachment.payload.text, /original deadline/);
  assert.equal(messages[4].message.attachment.payload.buttons[0].url, originalLink);
  assert.equal(english.link_expires_at, originalExpiry);
  assert.equal(english.link_sent_at, originalSentAt);
  assert.equal(participants.size, 4);

  english.link_expires_at = new Date(Date.now() - 1).toISOString();
  participants.get('31').user_id = profileId;
  assert.equal(await deliver(reply('expired', 'ITINERARY', '32')), 200);
  assert.equal(await deliver(reply('claimed', 'ITINERARY', '31')), 200);
  assert.equal(messages.length, 5);

  const spanish = reply('spanish', 'ITINERARY', '20');
  spanish.messaging[0].timestamp = String(Math.floor(spanish.messaging[0].timestamp / 1000));
  assert.equal(await deliver({ changes: [{ field: 'messages', value: spanish.messaging[0] }] }), 200);
  assert.equal(messages.length, 6);
  assert.match(messages[5].message.attachment.payload.text, /plazo original/);
  assert.equal(messages[5].message.attachment.payload.buttons[0].url, link.href);

  pricing = { regular_price_cents: 799, base_price_cents: 299, campaign_id: null };
  granted = 499;
  const soldOutES = comment('PRUEBAITBMO @friend @other', '42', '71', '101');
  assert.equal(await deliver(soldOutES), 200);
  assert.equal(messages.length, 6);
  granted = 500;
  configured = false;
  assert.equal(await deliver(soldOutES), 200);
  configured = true;
  status = 'paused';
  assert.equal(await deliver(soldOutES), 200);
  status = 'active';
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @friend', '42', '71', '101')), 200);
  assert.equal(messages.length, 6);

  assert.equal(await deliver(soldOutES), 200);
  assert.equal(await deliver(soldOutES), 200);
  assert.equal(messages.length, 7);
  assert.deepEqual(messages[6].recipient, { comment_id: '101' });
  assert.match(messages[6].message.text, /agotaron.*US\$2\.99.*63 %/);
  assert.equal(messages[6].message.text.split('\n\n')[1], env.ITBMO_INSTAGRAM_CAMPAIGN_ORIGIN + '/planner.html?lang=es');
  assert.equal(participants.get('71').link_expires_at, undefined);
  assert.equal(participants.get('71').link_sent_at, undefined);
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '42', '20', '105')), 200);
  assert.equal(participants.get('20').link_expires_at, new Date(linkExpiry).toISOString());
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '43', '72', '102')), 200);
  assert.match(messages[7].message.text, /claimed.*US\$2\.99.*63%/);
  assert.equal(messages[7].message.text.split('\n\n')[1], env.ITBMO_INSTAGRAM_CAMPAIGN_ORIGIN + '/planner.html?lang=en');
  pricing.base_price_cents = 799;
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '43', '73', '103')), 200);
  assert.match(messages[8].message.text, /US\$7\.99/);
  assert.doesNotMatch(messages[8].message.text, /%/);

  pricing = { regular_price_cents: 799, base_price_cents: 799, campaign_id: campaignId };
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '42', '71', '104')), 200);
  claimLink(messages[9], '104', 'es');

  process.env.ITBMO_INSTAGRAM_LOGIN_MODE = 'invalid';
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other')), 404);
  process.env.ITBMO_INSTAGRAM_LOGIN_MODE = 'unified_login';

  process.env.ITBMO_INSTAGRAM_CAMPAIGN_ENABLED = 'false';
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other')), 404);
  assert.deepEqual(await instagramCampaignAction('instagram_status', {}, 'fixture-session'), { ok: true, available: false });

  process.env.ITBMO_INSTAGRAM_WEBHOOK_VERIFY_ONLY = 'true';
  const originalRequests = graphRequests.length;
  const originalParticipants = participants.size;
  const handshake = response();
  await instagramCampaignWebhook({
    method: 'GET',
    query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': env.ITBMO_INSTAGRAM_VERIFY_TOKEN,
      'hub.challenge': '4242'
    }
  }, handshake);
  assert.equal(handshake.code, 200);
  assert.equal(handshake.value, '4242');
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '42', '99')), 200);
  assert.equal(await deliver(reply('5')), 200);
  assert.equal(await deliver(reply('6'), { secret: 'wrong' }), 403);
  assert.equal(graphRequests.length, originalRequests);
  assert.equal(participants.size, originalParticipants);
  assert.equal((await instagramCampaignAction('instagram_claim', { token }, 'fixture-session')).code, 'CAMPAIGN_UNAVAILABLE');

  process.env.VERCEL_ENV = 'production';
  assert.equal(await deliver(reply('7')), 404);
});
