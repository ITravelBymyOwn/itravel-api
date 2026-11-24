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
    setHeader() {},
    status(code) { this.code = code; return this; },
    send(value) { this.value = value; return this; },
    end() { return this; }
  };
}

test('Instagram delivery respects scope, language, valid mentions, deduplication and signed claims', async (t) => {
  Object.assign(process.env, env);
  const { countMentions, instagramCampaignAction, instagramCampaignWebhook } = await import('../api/_lib/instagram-campaign.js');
  const messages = [];
  const graphRequests = [];
  const participants = new Map();
  let claimInput = null;
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
      return json({ regular_price_cents: 799, base_price_cents: 799, campaign_id: campaignId });
    }
    if (url.pathname.endsWith('/instagram_campaign_settings')) {
      return json([{ campaigns: {
        status: 'active', starts_at: new Date(Date.now() - 600_000).toISOString(),
        ends_at: new Date(Date.now() + 600_000).toISOString()
      } }]);
    }
    if (url.pathname.endsWith('/instagram_campaign_participation')) {
      if (init.method === 'POST') {
        if (!participants.has(body.instagram_id)) participants.set(body.instagram_id, { id: participationId, ...body });
        return json([]);
      }
      const row = url.searchParams.has('instagram_id') ?
        participants.get(url.searchParams.get('instagram_id').slice(3)) : [...participants.values()].at(-1);
      if (!row) return json([]);
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
  function claimLink(sent, commentId, title, language) {
    assert.deepEqual(sent.recipient, { comment_id: commentId });
    assert.equal(sent.message.text, undefined);
    assert.equal(sent.message.attachment.type, 'template');
    const { template_type, text, buttons } = sent.message.attachment.payload;
    assert.equal(template_type, 'button');
    assert.doesNotMatch(text, /CONFIRM/);
    assert.equal(text.split('\n\n').at(-1), buttons[0].url);
    assert.match(text, language === 'es' ? /abre este enlace/ : /open this link/);
    assert.match(text, /(?:sigue a|follow) @itravelbymyown/i);
    assert.match(text, language === 'es' ? /24 horas/ : /24 hours/);
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].type, 'web_url');
    assert.equal(buttons[0].title, title);
    assert.ok(title.length <= 20);
    const link = new URL(buttons[0].url);
    assert.equal(link.origin, env.ITBMO_INSTAGRAM_CAMPAIGN_ORIGIN);
    assert.equal(link.pathname, '/planner.html');
    assert.equal(link.searchParams.get('lang'), language);
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
  const link = claimLink(messages[0], '50', 'Canjear itinerario', 'es');
  assert.equal(await deliver(reply('1')), 200);
  assert.equal(messages.length, 1);
  const token = new URLSearchParams(link.hash.slice(1)).get('itbmo_campaign');
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
    id: participationId, instagram_id: '30', comment_id: '60', language: 'es',
    intro_sent_at: new Date().toISOString()
  });
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '42', '30', '60')), 200);
  assert.equal(messages.length, 1);
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '42', '30', '61')), 200);
  claimLink(messages[1], '61', 'Canjear itinerario', 'es');
  assert.equal(participants.get('30').comment_id, '61');
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '43', '31', '62')), 200);
  claimLink(messages[2], '62', 'Claim free itinerary', 'en');
  assert.ok(graphRequests.every(request => request.host === 'graph.instagram.com'));

  process.env.ITBMO_INSTAGRAM_LOGIN_MODE = 'unified_login';
  assert.equal(await deliver(comment('PRUEBAITBMO @friend @other', '43', '32', '63')), 200);
  claimLink(messages[3], '63', 'Claim free itinerary', 'en');
  assert.deepEqual(graphRequests.at(-1), {
    host: 'graph.facebook.com',
    path: '/v27.0/100/messages',
    body: messages[3]
  });

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
