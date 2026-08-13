import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const REST_URL = `${SUPABASE_URL}/rest/v1`;

function jsonHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra
  };
}

function normalizeUsername(value = "") {
  return value.trim().toLowerCase();
}

function normalizeEmail(value = "") {
  return value.trim().toLowerCase();
}

function normalizeName(value = "") {
  return value.trim().replace(/\s+/g, " ");
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validUsername(username) {
  return /^[a-z0-9][a-z0-9._-]{2,29}$/.test(username);
}

function validAgeRange(value) {
  return ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"].includes(value);
}

function validCountryCode(value) {
  return /^[A-Z]{2}$/.test(value);
}

function createRawSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
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

async function findProfileByUsernameOrEmail(username, email) {
  const encodedUsername = encodeURIComponent(username);
  const encodedEmail = encodeURIComponent(email);

  const result = await supabaseFetch(
    `/profiles?select=id,username,email,first_name,last_name,age_range,country_code,account_status&username=eq.${encodedUsername}&email=eq.${encodedEmail}&limit=1`,
    { method: "GET" }
  );

  return Array.isArray(result) ? result[0] || null : null;
}

async function createSession(userId) {
  const rawToken = createRawSessionToken();
  const tokenHash = hashToken(rawToken);

  const session = await supabaseFetch("/user_sessions", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      user_id: userId,
      token_hash: tokenHash,
      auth_level: "mvp_weak"
    })
  });

  return {
    rawToken,
    session: Array.isArray(session) ? session[0] : null
  };
}

async function handleRegister(req, res, body) {
  const firstName = normalizeName(body.first_name);
  const lastName = normalizeName(body.last_name);
  const username = normalizeUsername(body.username);
  const email = normalizeEmail(body.email);
  const ageRange = body.age_range;
  const countryCode = String(body.country_code || "").trim().toUpperCase();

  const termsAccepted = body.terms_accepted === true;
  const privacyAccepted = body.privacy_accepted === true;
  const marketingConsent = body.marketing_consent === true;

  if (
    !firstName ||
    !lastName ||
    !username ||
    !email ||
    !ageRange ||
    !countryCode
  ) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields"
    });
  }

  if (!validUsername(username)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid username"
    });
  }

  if (!validEmail(email)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid email"
    });
  }

  if (!validAgeRange(ageRange)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid age range"
    });
  }

  if (!validCountryCode(countryCode)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid country code"
    });
  }

  if (!termsAccepted || !privacyAccepted) {
    return res.status(400).json({
      ok: false,
      error: "Terms and Privacy Policy must be accepted"
    });
  }

  const duplicateCheck = await supabaseFetch(
    `/profiles?select=id,username,email&or=(username.eq.${encodeURIComponent(
      username
    )},email.eq.${encodeURIComponent(email)})`,
    { method: "GET" }
  );

  if (Array.isArray(duplicateCheck) && duplicateCheck.length > 0) {
    const usernameTaken = duplicateCheck.some(
      (profile) => profile.username === username
    );

    const emailTaken = duplicateCheck.some(
      (profile) => profile.email === email
    );

    return res.status(409).json({
      ok: false,
      error: "Account already exists",
      username_taken: usernameTaken,
      email_taken: emailTaken
    });
  }

  const createdProfiles = await supabaseFetch("/profiles", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      username,
      first_name: firstName,
      last_name: lastName,
      email,
      age_range: ageRange,
      country_code: countryCode,
      preferred_language: body.preferred_language || null,
      registration_source: body.registration_source || "planner",
      utm_source: body.utm_source || null,
      utm_medium: body.utm_medium || null,
      utm_campaign: body.utm_campaign || null,
      utm_content: body.utm_content || null,
      utm_term: body.utm_term || null,
      referrer: body.referrer || null
    })
  });

  const profile = Array.isArray(createdProfiles)
    ? createdProfiles[0]
    : null;

  if (!profile?.id) {
    throw new Error("Profile creation returned no ID");
  }

  const { rawToken, session } = await createSession(profile.id);

  const consentRows = [
    {
      user_id: profile.id,
      session_id: session?.id || null,
      consent_type: "terms_of_use",
      granted: true,
      document_version: body.terms_version || "1.0",
      document_url: body.terms_url || null,
      source: "planner"
    },
    {
      user_id: profile.id,
      session_id: session?.id || null,
      consent_type: "privacy_policy",
      granted: true,
      document_version: body.privacy_version || "1.0",
      document_url: body.privacy_url || null,
      source: "planner"
    },
    {
      user_id: profile.id,
      session_id: session?.id || null,
      consent_type: "marketing",
      granted: marketingConsent,
      document_version: body.marketing_version || "1.0",
      document_url: null,
      source: "planner"
    }
  ];

  await supabaseFetch("/consents", {
    method: "POST",
    body: JSON.stringify(consentRows)
  });

  await supabaseFetch("/billing_accounts", {
    method: "POST",
    body: JSON.stringify({
      user_id: profile.id,
      monetization_model: "free",
      plan_code: "free",
      billing_status: "inactive",
      credits_balance: 0
    })
  });

  await supabaseFetch("/user_events", {
    method: "POST",
    body: JSON.stringify({
      user_id: profile.id,
      session_id: session?.id || null,
      event_name: "account_created",
      event_category: "account",
      properties: {
        registration_source: body.registration_source || "planner"
      }
    })
  });

  return res.status(201).json({
    ok: true,
    action: "register",
    user: {
      id: profile.id,
      username: profile.username,
      first_name: profile.first_name,
      last_name: profile.last_name,
      email: profile.email,
      age_range: profile.age_range,
      country_code: profile.country_code
    },
    session_token: rawToken,
    session_expires_at: session?.expires_at || null
  });
}

async function handleLogin(req, res, body) {
  const username = normalizeUsername(body.username);
  const email = normalizeEmail(body.email);

  if (!username || !email) {
    return res.status(400).json({
      ok: false,
      error: "Username and email are required"
    });
  }

  const profile = await findProfileByUsernameOrEmail(username, email);

  if (!profile || profile.account_status !== "active") {
    return res.status(401).json({
      ok: false,
      error: "Invalid username or email"
    });
  }

  const { rawToken, session } = await createSession(profile.id);

  await supabaseFetch("/user_events", {
    method: "POST",
    body: JSON.stringify({
      user_id: profile.id,
      session_id: session?.id || null,
      event_name: "login",
      event_category: "account",
      properties: {
        auth_level: "mvp_weak"
      }
    })
  });

  return res.status(200).json({
    ok: true,
    action: "login",
    user: profile,
    session_token: rawToken,
    session_expires_at: session?.expires_at || null
  });
}

async function handleSession(req, res, body) {
  const rawToken = String(body.session_token || "").trim();

  if (!rawToken) {
    return res.status(400).json({
      ok: false,
      error: "Session token is required"
    });
  }

  const tokenHash = hashToken(rawToken);

  const sessions = await supabaseFetch(
    `/user_sessions?select=id,user_id,expires_at,revoked_at&token_hash=eq.${encodeURIComponent(
      tokenHash
    )}&limit=1`,
    { method: "GET" }
  );

  const session = Array.isArray(sessions) ? sessions[0] || null : null;

  if (
    !session ||
    session.revoked_at ||
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    return res.status(401).json({
      ok: false,
      error: "Invalid or expired session"
    });
  }

  const profiles = await supabaseFetch(
    `/profiles?select=id,username,email,first_name,last_name,age_range,country_code,account_status& id=eq.${encodeURIComponent(
      session.user_id
    )}`.replace("& ", "&"),
    { method: "GET" }
  );

  const profile = Array.isArray(profiles) ? profiles[0] || null : null;

  if (!profile || profile.account_status !== "active") {
    return res.status(401).json({
      ok: false,
      error: "User unavailable"
    });
  }

  await supabaseFetch(
    `/user_sessions?id=eq.${encodeURIComponent(session.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        last_seen_at: new Date().toISOString()
      })
    }
  );

  await supabaseFetch(
    `/profiles?id=eq.${encodeURIComponent(profile.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        last_seen_at: new Date().toISOString()
      })
    }
  );

  return res.status(200).json({
    ok: true,
    action: "session",
    user: profile
  });
}

async function handleLogout(req, res, body) {
  const rawToken = String(body.session_token || "").trim();

  if (!rawToken) {
    return res.status(200).json({
      ok: true,
      action: "logout"
    });
  }

  const tokenHash = hashToken(rawToken);

  await supabaseFetch(
    `/user_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        revoked_at: new Date().toISOString()
      })
    }
  );

  return res.status(200).json({
    ok: true,
    action: "logout"
  });
}

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

    if (action === "register") {
      return await handleRegister(req, res, body);
    }

    if (action === "login") {
      return await handleLogin(req, res, body);
    }

    if (action === "session") {
      return await handleSession(req, res, body);
    }

    if (action === "logout") {
      return await handleLogout(req, res, body);
    }

    return res.status(400).json({
      ok: false,
      error: "Unknown action"
    });
  } catch (error) {
    console.error("ITBMO user endpoint error:", error);

    return res.status(500).json({
      ok: false,
      error: "Unexpected server error"
    });
  }
}
