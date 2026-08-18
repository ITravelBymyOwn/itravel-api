import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const REST_URL = `${SUPABASE_URL}/rest/v1`;

/* =========================================================
   ITBMO PAYMENTS API · v1.1
   ---------------------------------------------------------
   Supported now:
   - Payment status by trip
   - Public-safe checkout config
   - PayPal create order
   - PayPal capture order
   - Server-side price enforcement
   - Supabase payment ledger
   - User event logging
   - Billing account update

   Tilopay:
   - Explicitly gated until account credentials + exact merchant
     integration contract are available.
   - No card data is ever accepted by this endpoint.
========================================================= */

const COMMERCE = {
  currency: "USD",
  regularPrice: 5.99,
  promotions: {
    launch_offer: {
      code: "launch_offer",
      amount: 2.99,
      regularAmount: 5.99,
      active: true
    }
  }
};

const PAYPAL_ENV = String(process.env.PAYPAL_ENV || "sandbox").trim().toLowerCase();
const PAYPAL_CLIENT_ID = String(process.env.PAYPAL_CLIENT_ID || "").trim();
const PAYPAL_CLIENT_SECRET = String(process.env.PAYPAL_CLIENT_SECRET || "").trim();

/*
  ADMIN TEST BYPASS
  - Safe default: disabled.
  - Works only in Vercel Preview unless ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION=true.
  - Identify the admin by the Supabase user UUID, never by a browser-visible secret.
*/
const ITBMO_ADMIN_TEST_BYPASS =
  String(process.env.ITBMO_ADMIN_TEST_BYPASS || "false").toLowerCase() === "true";
const ITBMO_ADMIN_USER_ID = String(process.env.ITBMO_ADMIN_USER_ID || "").trim();
const ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION =
  String(process.env.ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION || "false").toLowerCase() === "true";
const INFO_CHAT_MAX_QUERIES = 10;

function isAdminTestBypass(userId) {
  if (!ITBMO_ADMIN_TEST_BYPASS || !ITBMO_ADMIN_USER_ID) return false;
  if (String(userId || "") !== ITBMO_ADMIN_USER_ID) return false;

  const isProduction = String(process.env.VERCEL_ENV || "").toLowerCase() === "production";
  return !isProduction || ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION;
}

const PAYPAL_API_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const TILOPAY_ENABLED =
  String(process.env.TILOPAY_ENABLED || "false").toLowerCase() === "true";

function jsonHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function money(value) {
  return Number(value).toFixed(2);
}

function normalizeString(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/\s+/g, " ");
  return s ? s.slice(0, maxLength) : null;
}

async function supabaseFetch(path, options = {}) {
  const response = await fetch(`${REST_URL}${path}`, {
    ...options,
    headers: jsonHeaders(options.headers || {})
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function getActiveSession(rawToken) {
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);

  const sessions = await supabaseFetch(
    `/user_sessions?select=id,user_id,expires_at,revoked_at&token_hash=eq.${encodeURIComponent(
      tokenHash
    )}&limit=1`,
    { method: "GET" }
  );

  const session = Array.isArray(sessions) ? sessions[0] || null : null;

  if (!session || session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  return session;
}

async function getOwnedTrip(tripId, userId) {
  if (!tripId || !userId) return null;

  const trips = await supabaseFetch(
    `/trips?select=id,user_id,status,trip_name,destinations,language&` +
      `id=eq.${encodeURIComponent(tripId)}&` +
      `user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { method: "GET" }
  );

  return Array.isArray(trips) ? trips[0] || null : null;
}

function resolveOffer(promotionCode) {
  const requested = String(promotionCode || "").trim();

  if (
    requested &&
    COMMERCE.promotions[requested] &&
    COMMERCE.promotions[requested].active
  ) {
    const promo = COMMERCE.promotions[requested];
    return {
      promotionCode: promo.code,
      amount: promo.amount,
      regularAmount: promo.regularAmount
    };
  }

  return {
    promotionCode: null,
    amount: COMMERCE.regularPrice,
    regularAmount: COMMERCE.regularPrice
  };
}

async function createEvent({ session, tripId, eventName, properties = {} }) {
  try {
    await supabaseFetch("/user_events", {
      method: "POST",
      body: JSON.stringify({
        user_id: session?.user_id || null,
        trip_id: tripId || null,
        session_id: session?.id || null,
        event_name: eventName,
        event_category: "payment",
        properties
      })
    });
  } catch (error) {
    // Payment must not fail only because analytics logging failed.
    console.error("ITBMO payment event logging error:", error);
  }
}

async function findPaidPayment(tripId, userId) {
  const rows = await supabaseFetch(
    `/payments?select=id,provider,provider_order_id,provider_transaction_id,` +
      `amount,currency,status,promotion_code,paid_at,created_at&` +
      `trip_id=eq.${encodeURIComponent(tripId)}&` +
      `user_id=eq.${encodeURIComponent(userId)}&` +
      `status=eq.paid&order=paid_at.desc&limit=1`,
    { method: "GET" }
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function countInfoChatQueries(tripId, userId) {
  const rows = await supabaseFetch(
    `/user_events?select=id&` +
      `trip_id=eq.${encodeURIComponent(tripId)}&` +
      `user_id=eq.${encodeURIComponent(userId)}&` +
      `event_name=eq.info_chat_query&limit=${INFO_CHAT_MAX_QUERIES + 20}`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows.length : 0;
}

async function findPaymentByPayPalOrder(orderId, tripId, userId) {
  const rows = await supabaseFetch(
    `/payments?select=*&provider=eq.paypal&` +
      `provider_order_id=eq.${encodeURIComponent(orderId)}&` +
      `trip_id=eq.${encodeURIComponent(tripId)}&` +
      `user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { method: "GET" }
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function createPaymentRow({
  session,
  trip,
  provider,
  offer,
  providerOrderId = null,
  status = "pending"
}) {
  const id = uuid();

  const rows = await supabaseFetch("/payments", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      id,
      user_id: session.user_id,
      trip_id: trip.id,
      session_id: session.id,
      provider,
      provider_order_id: providerOrderId,
      amount: offer.amount,
      regular_amount: offer.regularAmount,
      currency: COMMERCE.currency,
      status,
      promotion_code: offer.promotionCode,
      metadata: {
        source: "planner",
        product: "itbmo_premium_journey",
        paypal_env: provider === "paypal" ? PAYPAL_ENV : null
      }
    })
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function patchPayment(paymentId, patch) {
  const rows = await supabaseFetch(
    `/payments?id=eq.${encodeURIComponent(paymentId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        ...patch,
        updated_at: nowIso()
      })
    }
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function markBillingActive(userId, provider) {
  try {
    await supabaseFetch(
      `/billing_accounts?user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          monetization_model: "pay_per_trip",
          plan_code: "premium_journey",
          billing_status: "active",
          billing_provider: provider
        })
      }
    );
  } catch (error) {
    // Entitlement is controlled by paid payments, not this convenience row.
    console.error("ITBMO billing account update error:", error);
  }
}

/* =========================================================
   PAYPAL
========================================================= */

async function paypalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    const error = new Error("PayPal is not configured");
    error.code = "PAYPAL_NOT_CONFIGURED";
    throw error;
  }

  const credentials = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: "grant_type=client_credentials"
  });

  const data = await response.json();

  if (!response.ok || !data?.access_token) {
    const error = new Error("Unable to authenticate with PayPal");
    error.data = data;
    throw error;
  }

  return data.access_token;
}

async function paypalRequest(path, options = {}) {
  const token = await paypalAccessToken();

  const response = await fetch(`${PAYPAL_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers
    }
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const error = new Error("PayPal request failed");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function handleConfig(res) {
  return res.status(200).json({
    ok: true,
    currency: COMMERCE.currency,
    regular_price: money(COMMERCE.regularPrice),
    promotion: {
      code: "launch_offer",
      active: COMMERCE.promotions.launch_offer.active,
      price: money(COMMERCE.promotions.launch_offer.amount)
    },
    paypal_enabled: Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET),
    paypal_client_id: PAYPAL_CLIENT_ID || null,
    paypal_environment: PAYPAL_ENV,
    tilopay_enabled: TILOPAY_ENABLED
  });
}

async function handleStatus(res, body, session) {
  const tripId = normalizeString(body.trip_id, 100);

  if (!tripId) {
    return res.status(400).json({
      ok: false,
      error: "Trip ID is required"
    });
  }

  const trip = await getOwnedTrip(tripId, session.user_id);

  if (!trip) {
    return res.status(404).json({
      ok: false,
      error: "Trip not found"
    });
  }

  const payment = await findPaidPayment(trip.id, session.user_id);
  const adminBypass = isAdminTestBypass(session.user_id);
  const authorized = Boolean(payment) || adminBypass;
  const infoUsed = authorized
    ? Math.min(INFO_CHAT_MAX_QUERIES, await countInfoChatQueries(trip.id, session.user_id))
    : 0;

  return res.status(200).json({
    ok: true,
    paid: authorized,
    admin_bypass: adminBypass,
    entitlement_source: payment ? "payment" : (adminBypass ? "admin_test_bypass" : null),
    info_chat_authorized: authorized,
    info_chat_limit: INFO_CHAT_MAX_QUERIES,
    info_chat_used: infoUsed,
    info_chat_remaining: authorized ? Math.max(0, INFO_CHAT_MAX_QUERIES - infoUsed) : 0,
    payment: payment
      ? {
          id: payment.id,
          provider: payment.provider,
          amount: payment.amount,
          currency: payment.currency,
          paid_at: payment.paid_at
        }
      : null
  });
}

async function handlePayPalCreateOrder(res, body, session) {
  const tripId = normalizeString(body.trip_id, 100);

  if (!tripId) {
    return res.status(400).json({
      ok: false,
      error: "Trip ID is required"
    });
  }

  const trip = await getOwnedTrip(tripId, session.user_id);

  if (!trip) {
    return res.status(404).json({
      ok: false,
      error: "Trip not found"
    });
  }

  const existingPaid = await findPaidPayment(trip.id, session.user_id);

  if (existingPaid) {
    return res.status(200).json({
      ok: true,
      already_paid: true,
      paid: true,
      payment_id: existingPaid.id
    });
  }

  const offer = resolveOffer(body.promotion);
  const payment = await createPaymentRow({
    session,
    trip,
    provider: "paypal",
    offer
  });

  if (!payment?.id) {
    throw new Error("Payment row creation returned no ID");
  }

  try {
    const paypalOrder = await paypalRequest("/v2/checkout/orders", {
      method: "POST",
      headers: {
        "PayPal-Request-Id": payment.id
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: trip.id,
            custom_id: payment.id,
            description: "ITBMO Premium Journey",
            amount: {
              currency_code: COMMERCE.currency,
              value: money(offer.amount)
            }
          }
        ],
        application_context: {
          brand_name: "I Travel By My Own",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW"
        }
      })
    });

    if (!paypalOrder?.id) {
      throw new Error("PayPal returned no order ID");
    }

    await patchPayment(payment.id, {
      provider_order_id: paypalOrder.id,
      status: "pending",
      provider_status: paypalOrder.status || null
    });

    await createEvent({
      session,
      tripId: trip.id,
      eventName: "payment_started",
      properties: {
        provider: "paypal",
        payment_id: payment.id,
        amount: offer.amount,
        currency: COMMERCE.currency,
        promotion_code: offer.promotionCode
      }
    });

    return res.status(201).json({
      ok: true,
      order_id: paypalOrder.id,
      payment_id: payment.id
    });
  } catch (error) {
    await patchPayment(payment.id, {
      status: "failed",
      failed_at: nowIso(),
      failure_code: normalizeString(
        error?.data?.name || error?.code || "PAYPAL_CREATE_FAILED",
        120
      )
    });

    throw error;
  }
}

function extractPayPalCapture(order) {
  const capture =
    order?.purchase_units?.[0]?.payments?.captures?.[0] || null;

  return capture;
}

async function handlePayPalCaptureOrder(res, body, session) {
  const tripId = normalizeString(body.trip_id, 100);
  const orderId = normalizeString(body.order_id, 100);

  if (!tripId || !orderId) {
    return res.status(400).json({
      ok: false,
      error: "Trip ID and PayPal order ID are required"
    });
  }

  const trip = await getOwnedTrip(tripId, session.user_id);

  if (!trip) {
    return res.status(404).json({
      ok: false,
      error: "Trip not found"
    });
  }

  const payment = await findPaymentByPayPalOrder(
    orderId,
    trip.id,
    session.user_id
  );

  if (!payment) {
    return res.status(404).json({
      ok: false,
      error: "Payment not found"
    });
  }

  if (payment.status === "paid") {
    return res.status(200).json({
      ok: true,
      paid: true,
      payment_id: payment.id,
      already_captured: true
    });
  }

  try {
    const order = await paypalRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          "PayPal-Request-Id": `${payment.id}-capture`
        },
        body: JSON.stringify({})
      }
    );

    const capture = extractPayPalCapture(order);

    const capturedCurrency = String(
      capture?.amount?.currency_code || ""
    ).toUpperCase();

    const capturedValue = Number(capture?.amount?.value);

    const expectedValue = Number(payment.amount);

    const isCompleted =
      order?.status === "COMPLETED" &&
      capture?.status === "COMPLETED";

    const amountMatches =
      capturedCurrency === String(payment.currency).toUpperCase() &&
      Number.isFinite(capturedValue) &&
      Math.abs(capturedValue - expectedValue) < 0.0001;

    if (!isCompleted || !amountMatches) {
      await patchPayment(payment.id, {
        status: "failed",
        provider_status:
          normalizeString(capture?.status || order?.status, 100),
        failed_at: nowIso(),
        failure_code: !isCompleted
          ? "PAYPAL_NOT_COMPLETED"
          : "PAYPAL_AMOUNT_MISMATCH"
      });

      return res.status(409).json({
        ok: false,
        paid: false,
        error: "Payment could not be verified"
      });
    }

    const paidAt =
      capture?.create_time ||
      capture?.update_time ||
      order?.update_time ||
      nowIso();

    await patchPayment(payment.id, {
      status: "paid",
      provider_status: capture.status,
      provider_transaction_id: capture.id || null,
      paid_at: paidAt,
      failed_at: null,
      failure_code: null
    });

    await markBillingActive(session.user_id, "paypal");

    await createEvent({
      session,
      tripId: trip.id,
      eventName: "payment_completed",
      properties: {
        provider: "paypal",
        payment_id: payment.id,
        provider_order_id: orderId,
        provider_transaction_id: capture.id || null,
        amount: expectedValue,
        currency: payment.currency,
        promotion_code: payment.promotion_code || null
      }
    });

    return res.status(200).json({
      ok: true,
      paid: true,
      payment_id: payment.id,
      provider: "paypal",
      amount: money(expectedValue),
      currency: payment.currency
    });
  } catch (error) {
    // Do not blindly mark failed on transport/API errors because the
    // provider may have captured successfully. The user can retry and
    // PayPal idempotency + status verification remain authoritative.
    console.error("PayPal capture error:", error);
    throw error;
  }
}

/* =========================================================
   TILOPAY
   ---------------------------------------------------------
   IMPORTANT:
   Tilopay publicly documents API/SDK availability but its exact
   merchant endpoint/credential contract is account-specific and is
   not safely inferable from public pages.

   This action therefore returns a controlled configuration response
   until the real credentials + API collection are supplied.
========================================================= */

async function handleTilopayCreateCheckout(res, body, session) {
  const tripId = normalizeString(body.trip_id, 100);

  if (!tripId) {
    return res.status(400).json({
      ok: false,
      error: "Trip ID is required"
    });
  }

  const trip = await getOwnedTrip(tripId, session.user_id);

  if (!trip) {
    return res.status(404).json({
      ok: false,
      error: "Trip not found"
    });
  }

  const existingPaid = await findPaidPayment(trip.id, session.user_id);

  if (existingPaid) {
    return res.status(200).json({
      ok: true,
      paid: true,
      payment_id: existingPaid.id
    });
  }

  if (!TILOPAY_ENABLED) {
    return res.status(503).json({
      ok: false,
      error: "Tilopay is not enabled yet",
      code: "TILOPAY_NOT_ENABLED"
    });
  }

  return res.status(501).json({
    ok: false,
    error:
      "Tilopay merchant API credentials and integration contract are required before activation",
    code: "TILOPAY_INTEGRATION_PENDING"
  });
}

/* =========================================================
   HANDLER
========================================================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Server configuration error"
    });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const action = String(body.action || "").trim().toLowerCase();

    /*
      config still requires a valid ITBMO session because the checkout
      is available only to registered users in the current MVP.
    */
    const sessionToken = String(body.session_token || "").trim();

    if (!sessionToken) {
      return res.status(401).json({
        ok: false,
        error: "Session required"
      });
    }

    const session = await getActiveSession(sessionToken);

    if (!session) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or expired session"
      });
    }

    if (action === "config") {
      return await handleConfig(res);
    }

    if (action === "status") {
      return await handleStatus(res, body, session);
    }

    if (action === "paypal_create_order") {
      return await handlePayPalCreateOrder(res, body, session);
    }

    if (action === "paypal_capture_order") {
      return await handlePayPalCaptureOrder(res, body, session);
    }

    if (action === "tilopay_create_checkout") {
      return await handleTilopayCreateCheckout(res, body, session);
    }

    return res.status(400).json({
      ok: false,
      error: "Unknown action"
    });
  } catch (error) {
    console.error("ITBMO payment endpoint error:", {
      message: error?.message,
      status: error?.status,
      data: error?.data
    });

    const status =
      Number.isInteger(error?.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : 500;

    return res.status(status).json({
      ok: false,
      error:
        status >= 500
          ? "Payment service error"
          : "Payment request failed"
    });
  }
}
