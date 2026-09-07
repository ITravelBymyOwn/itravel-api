import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_PUBLIC_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

const REST_URL = `${SUPABASE_URL}/rest/v1`;
const AUTH_URL = `${SUPABASE_URL}/auth/v1`;

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

async function createSession(userId, authLevel = "mvp_weak") {
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
      auth_level: authLevel
    })
  });

  return {
    rawToken,
    session: Array.isArray(session) ? session[0] : null
  };
}


function authHeaders(extra = {}) {
  return {
    apikey: SUPABASE_PUBLIC_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra
  };
}

async function authFetch(path, options = {}) {
  if (!SUPABASE_PUBLIC_KEY) {
    const error = new Error("Supabase public key is not configured");
    error.status = 500;
    throw error;
  }

  const response = await fetch(`${AUTH_URL}${path}`, {
    ...options,
    headers: authHeaders(options.headers || {})
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
    const error = new Error("Supabase Auth request failed");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function validPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

function resolveRedirectUrl(body, fallbackPath = "/planner.html") {
  const requested = String(body.redirect_to || "").trim();
  if (requested) return requested;

  const origin = String(body.origin || "").trim().replace(/\/$/, "");
  if (origin) return `${origin}${fallbackPath}`;

  return `https://itravelbymyown.com${fallbackPath}`;
}

async function findProfileByAuthUserId(authUserId) {
  if (!authUserId) return null;

  const result = await supabaseFetch(
    `/profiles?select=id,auth_user_id,username,email,first_name,last_name,age_range,country_code,preferred_language,account_status,email_verified&auth_user_id=eq.${encodeURIComponent(
      authUserId
    )}&limit=1`,
    { method: "GET" }
  );

  return Array.isArray(result) ? result[0] || null : null;
}

async function findProfilesByEmail(email) {
  const result = await supabaseFetch(
    `/profiles?select=id,auth_user_id,username,email,first_name,last_name,age_range,country_code,preferred_language,account_status,email_verified&email=eq.${encodeURIComponent(
      email
    )}&order=created_at.desc`,
    { method: "GET" }
  );

  return Array.isArray(result) ? result : [];
}

async function getSessionRecord(rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) return null;

  const tokenHash = hashToken(token);
  const sessions = await supabaseFetch(
    `/user_sessions?select=id,user_id,auth_level,expires_at,revoked_at&token_hash=eq.${encodeURIComponent(
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
    return null;
  }

  return session;
}

async function createBillingAccount(userId) {
  await supabaseFetch("/billing_accounts", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      monetization_model: "free",
      plan_code: "free",
      billing_status: "inactive",
      credits_balance: 0
    })
  });
}

async function createConsentRows(profileId, sessionId, body) {
  const termsAccepted = body.terms_accepted === true;
  const privacyAccepted = body.privacy_accepted === true;
  const marketingConsent = body.marketing_consent === true;

  if (!termsAccepted || !privacyAccepted) {
    const error = new Error("Terms and Privacy Policy must be accepted");
    error.status = 400;
    throw error;
  }

  await supabaseFetch("/consents", {
    method: "POST",
    body: JSON.stringify([
      {
        user_id: profileId,
        session_id: sessionId || null,
        consent_type: "terms_of_use",
        granted: true,
        document_version: body.terms_version || "1.0",
        document_url: body.terms_url || null,
        source: "planner"
      },
      {
        user_id: profileId,
        session_id: sessionId || null,
        consent_type: "privacy_policy",
        granted: true,
        document_version: body.privacy_version || "1.0",
        document_url: body.privacy_url || null,
        source: "planner"
      },
      {
        user_id: profileId,
        session_id: sessionId || null,
        consent_type: "marketing",
        granted: marketingConsent,
        document_version: body.marketing_version || "1.0",
        document_url: null,
        source: "planner"
      }
    ])
  });
}

async function createMinimalProfile({
  authUserId = null,
  name,
  email,
  preferredLanguage = null,
  registrationSource = "planner",
  body = {}
}) {
  const createdProfiles = await supabaseFetch("/profiles", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      auth_user_id: authUserId,
      first_name: name,
      email,
      preferred_language: preferredLanguage || null,
      email_verified: false,
      registration_source: registrationSource,
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

  await createBillingAccount(profile.id);
  return profile;
}

async function handleGuest(req, res, body) {
  const name = normalizeName(body.name || body.first_name);
  const email = normalizeEmail(body.email);

  if (!name || !email) {
    return res.status(400).json({
      ok: false,
      error: "Name and email are required"
    });
  }

  if (!validEmail(email)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid email"
    });
  }

  if (body.terms_accepted !== true || body.privacy_accepted !== true) {
    return res.status(400).json({
      ok: false,
      error: "Terms and Privacy Policy must be accepted"
    });
  }

  const profile = await createMinimalProfile({
    name,
    email,
    preferredLanguage: body.preferred_language || null,
    registrationSource: body.registration_source || "planner_guest",
    body
  });

  const { rawToken, session } = await createSession(profile.id, "mvp_weak");

  await createConsentRows(profile.id, session?.id || null, body);

  await supabaseFetch("/user_events", {
    method: "POST",
    body: JSON.stringify({
      user_id: profile.id,
      session_id: session?.id || null,
      event_name: "guest_session_created",
      event_category: "account",
      properties: {
        registration_source: body.registration_source || "planner_guest"
      }
    })
  });

  return res.status(201).json({
    ok: true,
    action: "guest",
    user: {
      id: profile.id,
      first_name: profile.first_name,
      email: profile.email,
      is_registered: false,
      email_verified: false
    },
    session_token: rawToken,
    session_expires_at: session?.expires_at || null
  });
}

async function handleSignUp(req, res, body) {
  const name = normalizeName(body.name || body.first_name);
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const passwordConfirmation = String(body.password_confirmation || "");

  if (!name || !email || !password || !passwordConfirmation) {
    return res.status(400).json({
      ok: false,
      error: "Name, email, password and password confirmation are required"
    });
  }

  if (!validEmail(email)) {
    return res.status(400).json({ ok: false, error: "Invalid email" });
  }

  if (!validPassword(password)) {
    return res.status(400).json({
      ok: false,
      error: "Password does not meet security requirements"
    });
  }

  if (password !== passwordConfirmation) {
    return res.status(400).json({
      ok: false,
      error: "Passwords do not match"
    });
  }

  if (body.terms_accepted !== true || body.privacy_accepted !== true) {
    return res.status(400).json({
      ok: false,
      error: "Terms and Privacy Policy must be accepted"
    });
  }

  const existingProfiles = await findProfilesByEmail(email);
  const registeredProfile = existingProfiles.find(
    (profile) => profile.auth_user_id
  );

  if (registeredProfile) {
    return res.status(409).json({
      ok: false,
      error: "Account already exists",
      email_taken: true
    });
  }

  let guestSession = null;
  let guestProfile = null;

  if (body.session_token) {
    guestSession = await getSessionRecord(body.session_token);

    if (guestSession) {
      const profiles = await supabaseFetch(
        `/profiles?select=id,auth_user_id,email,first_name,account_status& id=eq.${encodeURIComponent(
          guestSession.user_id
        )}&limit=1`.replace("& ", "&"),
        { method: "GET" }
      );

      const candidate = Array.isArray(profiles) ? profiles[0] || null : null;

      if (
        candidate &&
        !candidate.auth_user_id &&
        candidate.account_status === "active" &&
        candidate.email === email
      ) {
        guestProfile = candidate;
      }
    }
  }

  const redirectTo = resolveRedirectUrl(body);
  const language = String(body.preferred_language || body.language || "en")
    .trim()
    .toLowerCase();

  const authData = await authFetch(
    `/signup?redirect_to=${encodeURIComponent(redirectTo)}`,
    {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        data: {
          name,
          language
        }
      })
    }
  );

  const authUser = authData?.user || authData;
  const authUserId = authUser?.id || null;

  if (!authUserId) {
    throw new Error("Supabase signup returned no user ID");
  }

  let profile = guestProfile;

  if (profile) {
    const updatedProfiles = await supabaseFetch(
      `/profiles?id=eq.${encodeURIComponent(profile.id)}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          auth_user_id: authUserId,
          first_name: name,
          preferred_language: language || null,
          email_verified: false,
          updated_at: new Date().toISOString()
        })
      }
    );

    profile = Array.isArray(updatedProfiles)
      ? updatedProfiles[0] || profile
      : profile;
  } else {
    profile = await createMinimalProfile({
      authUserId,
      name,
      email,
      preferredLanguage: language || null,
      registrationSource: body.registration_source || "planner",
      body
    });
  }

  await createConsentRows(profile.id, guestSession?.id || null, body);

  await supabaseFetch("/user_events", {
    method: "POST",
    body: JSON.stringify({
      user_id: profile.id,
      session_id: guestSession?.id || null,
      event_name: guestProfile ? "guest_account_upgrade_started" : "account_signup_started",
      event_category: "account",
      properties: {
        email_confirmation_required: true,
        registration_source: body.registration_source || "planner"
      }
    })
  });

  return res.status(201).json({
    ok: true,
    action: "sign_up",
    confirmation_required: true,
    user: {
      id: profile.id,
      first_name: profile.first_name,
      email: profile.email,
      is_registered: false,
      email_verified: false
    }
  });
}

async function handlePasswordLogin(req, res, body) {
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: "Email and password are required"
    });
  }

  const authData = await authFetch("/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  const authUser = authData?.user || null;

  if (!authUser?.id) {
    return res.status(401).json({
      ok: false,
      error: "Invalid email or password"
    });
  }

  let profile = await findProfileByAuthUserId(authUser.id);

  if (!profile) {
    const metadataName = normalizeName(
      authUser.user_metadata?.name || authUser.user_metadata?.first_name || "Traveler"
    );

    profile = await createMinimalProfile({
      authUserId: authUser.id,
      name: metadataName || "Traveler",
      email: normalizeEmail(authUser.email || email),
      preferredLanguage: authUser.user_metadata?.language || null,
      registrationSource: "supabase_auth_recovery",
      body: {}
    });
  }

  if (profile.account_status && profile.account_status !== "active") {
    return res.status(401).json({
      ok: false,
      error: "User unavailable"
    });
  }

  if (!profile.email_verified) {
    const updatedProfiles = await supabaseFetch(
      `/profiles?id=eq.${encodeURIComponent(profile.id)}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          email_verified: true,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      }
    );

    profile = Array.isArray(updatedProfiles)
      ? updatedProfiles[0] || profile
      : profile;
  }

  const { rawToken, session } = await createSession(
    profile.id,
    "supabase_auth"
  );

  await supabaseFetch("/user_events", {
    method: "POST",
    body: JSON.stringify({
      user_id: profile.id,
      session_id: session?.id || null,
      event_name: "login",
      event_category: "account",
      properties: {
        auth_level: "supabase_auth"
      }
    })
  });

  return res.status(200).json({
    ok: true,
    action: "sign_in",
    user: {
      ...profile,
      is_registered: true,
      email_verified: true
    },
    session_token: rawToken,
    session_expires_at: session?.expires_at || null
  });
}

async function handleForgotPassword(req, res, body) {
  const email = normalizeEmail(body.email);

  if (!email || !validEmail(email)) {
    return res.status(400).json({
      ok: false,
      error: "Valid email is required"
    });
  }

  const redirectTo = resolveRedirectUrl(body);

  await authFetch(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    body: JSON.stringify({ email })
  });

  return res.status(200).json({
    ok: true,
    action: "forgot_password"
  });
}

async function getAuthUserFromAccessToken(accessToken) {
  if (!accessToken) return null;

  const data = await authFetch("/user", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  return data?.user || data || null;
}

async function handleCompleteAuth(req, res, body) {
  const accessToken = String(body.access_token || "").trim();

  if (!accessToken) {
    return res.status(400).json({
      ok: false,
      error: "Access token is required"
    });
  }

  const authUser = await getAuthUserFromAccessToken(accessToken);

  if (!authUser?.id || !authUser.email) {
    return res.status(401).json({
      ok: false,
      error: "Invalid authentication callback"
    });
  }

  let profile = await findProfileByAuthUserId(authUser.id);

  if (!profile) {
    profile = await createMinimalProfile({
      authUserId: authUser.id,
      name: normalizeName(authUser.user_metadata?.name || "Traveler"),
      email: normalizeEmail(authUser.email),
      preferredLanguage: authUser.user_metadata?.language || null,
      registrationSource: "supabase_auth_callback",
      body: {}
    });
  }

  const updatedProfiles = await supabaseFetch(
    `/profiles?id=eq.${encodeURIComponent(profile.id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        email_verified: true,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    }
  );

  profile = Array.isArray(updatedProfiles)
    ? updatedProfiles[0] || profile
    : profile;

  const { rawToken, session } = await createSession(
    profile.id,
    "supabase_auth"
  );

  await supabaseFetch("/user_events", {
    method: "POST",
    body: JSON.stringify({
      user_id: profile.id,
      session_id: session?.id || null,
      event_name: "email_confirmed",
      event_category: "account",
      properties: {
        auth_level: "supabase_auth"
      }
    })
  });

  return res.status(200).json({
    ok: true,
    action: "complete_auth",
    user: {
      ...profile,
      is_registered: true,
      email_verified: true
    },
    session_token: rawToken,
    session_expires_at: session?.expires_at || null
  });
}

async function handleResetPassword(req, res, body) {
  const accessToken = String(body.access_token || "").trim();
  const password = String(body.password || "");
  const passwordConfirmation = String(body.password_confirmation || "");

  if (!accessToken || !password || !passwordConfirmation) {
    return res.status(400).json({
      ok: false,
      error: "Access token and new password are required"
    });
  }

  if (!validPassword(password)) {
    return res.status(400).json({
      ok: false,
      error: "Password does not meet security requirements"
    });
  }

  if (password !== passwordConfirmation) {
    return res.status(400).json({
      ok: false,
      error: "Passwords do not match"
    });
  }

  const authUser = await getAuthUserFromAccessToken(accessToken);

  if (!authUser?.id) {
    return res.status(401).json({
      ok: false,
      error: "Invalid or expired recovery session"
    });
  }

  await authFetch("/user", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ password })
  });

  return res.status(200).json({
    ok: true,
    action: "reset_password"
  });
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
    `/profiles?select=id,auth_user_id,username,email,first_name,last_name,age_range,country_code,preferred_language,account_status,email_verified& id=eq.${encodeURIComponent(
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
    user: {
      ...profile,
      is_registered: Boolean(profile.auth_user_id),
      email_verified: Boolean(profile.email_verified)
    }
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

    if (action === "guest") {
      return await handleGuest(req, res, body);
    }

    if (action === "sign_up") {
      return await handleSignUp(req, res, body);
    }

    if (action === "sign_in") {
      return await handlePasswordLogin(req, res, body);
    }

    if (action === "forgot_password") {
      return await handleForgotPassword(req, res, body);
    }

    if (action === "complete_auth") {
      return await handleCompleteAuth(req, res, body);
    }

    if (action === "reset_password") {
      return await handleResetPassword(req, res, body);
    }

    // Legacy MVP actions are intentionally kept during the feature branch
    // so the current Planner continues working while the UI is migrated.
    // They must be disabled before merging the auth redesign to production.
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
