import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const REST_URL = `${SUPABASE_URL}/rest/v1`;
const MAX_GENERATION_RUNS = 2;

const ITBMO_ADMIN_TEST_BYPASS =
  String(process.env.ITBMO_ADMIN_TEST_BYPASS || "false").toLowerCase() === "true";
const ITBMO_ADMIN_USER_ID = String(process.env.ITBMO_ADMIN_USER_ID || "").trim();
const ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION =
  String(process.env.ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION || "false").toLowerCase() === "true";

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

  const session = Array.isArray(sessions)
    ? sessions[0] || null
    : null;

  if (!session) return null;

  if (session.revoked_at) return null;

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return session;
}

function generationAdminBypass(userId) {
  if (!ITBMO_ADMIN_TEST_BYPASS || !ITBMO_ADMIN_USER_ID) return false;
  if (String(userId || "") !== ITBMO_ADMIN_USER_ID) return false;
  const isProduction = String(process.env.VERCEL_ENV || "").toLowerCase() === "production";
  return !isProduction || ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION;
}

async function getOwnedTripForGeneration(tripId, userId) {
  const rows = await supabaseFetch(
    `/trips?select=id,user_id,status,destinations,planner_input,itinerary_data,` +
    `generation_count,generated_at,created_at,updated_at&` +
    `id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function hasGenerationEntitlement(tripId, userId) {
  if (generationAdminBypass(userId)) return true;
  const rows = await supabaseFetch(
    `/payments?select=id&trip_id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(userId)}&status=eq.paid&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) && rows.length > 0;
}

function generationCheckpoint(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

async function patchOwnedTrip(tripId, userId, patch) {
  const rows = await supabaseFetch(
    `/trips?id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch)
    }
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

function validDateOrNull(value) {
  if (!value) return null;

  const date = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return value;
}

function normalizeString(value, maxLength = 500) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value)
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized) return null;

  return normalized.slice(0, maxLength);
}

async function handleCreate(res, body, session) {
  const destinations = Array.isArray(body.destinations)
    ? body.destinations
    : [];

  if (destinations.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "At least one destination is required"
    });
  }

  const travelersCount =
    body.travelers_count === null ||
    body.travelers_count === undefined ||
    body.travelers_count === ""
      ? null
      : Number(body.travelers_count);

  if (
    travelersCount !== null &&
    (
      !Number.isInteger(travelersCount) ||
      travelersCount < 1 ||
      travelersCount > 50
    )
  ) {
    return res.status(400).json({
      ok: false,
      error: "Invalid travelers count"
    });
  }

  const startDate = validDateOrNull(body.start_date);
  const endDate = validDateOrNull(body.end_date);

  if (
    body.start_date &&
    !startDate
  ) {
    return res.status(400).json({
      ok: false,
      error: "Invalid start date"
    });
  }

  if (
    body.end_date &&
    !endDate
  ) {
    return res.status(400).json({
      ok: false,
      error: "Invalid end date"
    });
  }

  if (
    startDate &&
    endDate &&
    new Date(endDate) < new Date(startDate)
  ) {
    return res.status(400).json({
      ok: false,
      error: "End date cannot be before start date"
    });
  }

  const plannerInput =
    body.planner_input &&
    typeof body.planner_input === "object" &&
    !Array.isArray(body.planner_input)
      ? body.planner_input
      : {};

  const createdTrips = await supabaseFetch("/trips", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      user_id: session.user_id,
      session_id: session.id,

      trip_name: normalizeString(body.trip_name, 150),

      status: "saved",

      start_date: startDate,
      end_date: endDate,

      travelers_count: travelersCount,

      travel_style: normalizeString(body.travel_style, 150),
      transportation: normalizeString(body.transportation, 150),

      special_conditions:
        normalizeString(body.special_conditions, 5000),

      language:
        normalizeString(body.language, 20),

      destinations,

      planner_input: plannerInput,

      planner_version:
        normalizeString(body.planner_version, 50),

      api_version:
        normalizeString(body.api_version, 50)
    })
  });

  const trip = Array.isArray(createdTrips)
    ? createdTrips[0]
    : null;

  if (!trip?.id) {
    throw new Error("Trip creation returned no ID");
  }

  await supabaseFetch("/user_events", {
    method: "POST",
    body: JSON.stringify({
      user_id: session.user_id,
      trip_id: trip.id,
      session_id: session.id,

      event_name: "destinations_saved",
      event_category: "trip",

      properties: {
        destinations_count: destinations.length,
        travelers_count: travelersCount,
        language: body.language || null
      }
    })
  });

  return res.status(201).json({
    ok: true,
    action: "create",
    trip: {
      id: trip.id,
      status: trip.status,
      created_at: trip.created_at
    }
  });
}

async function handleUpdate(res, body, session) {
  const tripId = String(body.trip_id || "").trim();

  if (!tripId) {
    return res.status(400).json({
      ok: false,
      error: "Trip ID is required"
    });
  }

  const existingTrips = await supabaseFetch(
    `/trips?select=id,user_id,status&` +
    `id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(session.user_id)}&limit=1`,
    { method: "GET" }
  );

  const existingTrip = Array.isArray(existingTrips)
    ? existingTrips[0] || null
    : null;

  if (!existingTrip) {
    return res.status(404).json({
      ok: false,
      error: "Trip not found"
    });
  }

  const patch = {};

  if (body.trip_name !== undefined) {
    patch.trip_name =
      normalizeString(body.trip_name, 150);
  }

  if (body.start_date !== undefined) {
    if (body.start_date === null || body.start_date === "") {
      patch.start_date = null;
    } else {
      const date = validDateOrNull(body.start_date);

      if (!date) {
        return res.status(400).json({
          ok: false,
          error: "Invalid start date"
        });
      }

      patch.start_date = date;
    }
  }

  if (body.end_date !== undefined) {
    if (body.end_date === null || body.end_date === "") {
      patch.end_date = null;
    } else {
      const date = validDateOrNull(body.end_date);

      if (!date) {
        return res.status(400).json({
          ok: false,
          error: "Invalid end date"
        });
      }

      patch.end_date = date;
    }
  }

  if (body.travelers_count !== undefined) {
    const count =
      body.travelers_count === null ||
      body.travelers_count === ""
        ? null
        : Number(body.travelers_count);

    if (
      count !== null &&
      (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 50
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid travelers count"
      });
    }

    patch.travelers_count = count;
  }

  if (body.travel_style !== undefined) {
    patch.travel_style =
      normalizeString(body.travel_style, 150);
  }

  if (body.transportation !== undefined) {
    patch.transportation =
      normalizeString(body.transportation, 150);
  }

  if (body.special_conditions !== undefined) {
    patch.special_conditions =
      normalizeString(body.special_conditions, 5000);
  }

  if (body.language !== undefined) {
    patch.language =
      normalizeString(body.language, 20);
  }

  if (body.destinations !== undefined) {
    if (!Array.isArray(body.destinations)) {
      return res.status(400).json({
        ok: false,
        error: "Destinations must be an array"
      });
    }

    patch.destinations = body.destinations;
  }

  if (body.planner_input !== undefined) {
    if (
      !body.planner_input ||
      typeof body.planner_input !== "object" ||
      Array.isArray(body.planner_input)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Planner input must be an object"
      });
    }

    patch.planner_input = body.planner_input;
  }

  if (body.planner_version !== undefined) {
    patch.planner_version =
      normalizeString(body.planner_version, 50);
  }

  if (body.api_version !== undefined) {
    patch.api_version =
      normalizeString(body.api_version, 50);
  }

  if (body.status !== undefined) {
    const allowedStatuses = [
      "draft",
      "saved",
      "generating",
      "generated",
      "failed",
      "archived"
    ];

    if (!allowedStatuses.includes(body.status)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid trip status"
      });
    }

    patch.status = body.status;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      ok: false,
      error: "Nothing to update"
    });
  }

  const updatedTrips = await supabaseFetch(
    `/trips?id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(session.user_id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify(patch)
    }
  );

  const trip = Array.isArray(updatedTrips)
    ? updatedTrips[0] || null
    : null;

  return res.status(200).json({
    ok: true,
    action: "update",
    trip: {
      id: trip?.id || tripId,
      status: trip?.status || patch.status || existingTrip.status,
      updated_at: trip?.updated_at || null
    }
  });
}

async function handleGet(res, body, session) {
  const tripId = String(body.trip_id || "").trim();

  if (!tripId) {
    return res.status(400).json({
      ok: false,
      error: "Trip ID is required"
    });
  }

  const trips = await supabaseFetch(
    `/trips?` +
    `select=id,trip_name,status,start_date,end_date,travelers_count,` +
    `travel_style,transportation,special_conditions,language,` +
    `destinations,planner_input,itinerary_data,planner_version,api_version,generation_count,` +
    `generated_at,created_at,updated_at&` +
    `id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(session.user_id)}&limit=1`,
    { method: "GET" }
  );

  const trip = Array.isArray(trips)
    ? trips[0] || null
    : null;

  if (!trip) {
    return res.status(404).json({
      ok: false,
      error: "Trip not found"
    });
  }

  return res.status(200).json({
    ok: true,
    action: "get",
    trip
  });
}

async function handleArchive(res, body, session) {
  const tripId = String(body.trip_id || "").trim();

  if (!tripId) {
    return res.status(400).json({ ok:false, error:"Trip ID is required" });
  }

  const trip = await getOwnedTripForGeneration(tripId, session.user_id);
  if (!trip) {
    return res.status(404).json({ ok:false, error:"Trip not found" });
  }

  if (trip.status === "archived") {
    return res.status(200).json({ ok:true, action:"archive", trip });
  }

  const now = new Date().toISOString();
  const checkpoint = generationCheckpoint(trip.itinerary_data);
  const updated = await patchOwnedTrip(tripId, session.user_id, {
    status:"archived",
    itinerary_data:{
      ...checkpoint,
      run_status:"archived",
      archived_at:now,
      updated_at:now
    }
  });

  return res.status(200).json({
    ok:true,
    action:"archive",
    trip:updated
  });
}

async function handleGenerationBegin(res, body, session) {
  const tripId = String(body.trip_id || "").trim();
  if (!tripId) {
    return res.status(400).json({ ok:false, error:"Trip ID is required" });
  }

  const trip = await getOwnedTripForGeneration(tripId, session.user_id);
  if (!trip) {
    return res.status(404).json({ ok:false, error:"Trip not found" });
  }

  if (!(await hasGenerationEntitlement(tripId, session.user_id))) {
    return res.status(402).json({ ok:false, code:"GENERATION_PAYMENT_REQUIRED", error:"Payment required" });
  }

  if (trip.status === "archived") {
    return res.status(409).json({ ok:false, code:"GENERATION_ARCHIVED", error:"Trip archived" });
  }

  const checkpoint = generationCheckpoint(trip.itinerary_data);
  if (trip.status === "generated") {
    return res.status(200).json({
      ok:true,
      action:"generation_begin",
      already_completed:true,
      new_run:false,
      trip
    });
  }

  const previousRuns = Math.max(0, Number(trip.generation_count || 0));
  const newRun = trip.status !== "generating";
  if (newRun && previousRuns >= MAX_GENERATION_RUNS) {
    return res.status(409).json({
      ok:false,
      code:"GENERATION_RECOVERY_EXHAUSTED",
      error:"Automatic generation recovery limit reached"
    });
  }

  const nextRuns = newRun ? previousRuns + 1 : Math.max(1, previousRuns);
  const completed = Array.isArray(checkpoint.completed_cities)
    ? checkpoint.completed_cities.map(String)
    : [];
  const attempts = generationCheckpoint(checkpoint.city_attempts);

  if (newRun && trip.status === "failed") {
    const destinations = Array.isArray(trip.destinations) ? trip.destinations : [];
    destinations.forEach(destination => {
      const city = String(destination?.city || "").trim();
      if (city && !completed.includes(city)) attempts[city] = 0;
    });
  }

  const nextCheckpoint = {
    ...checkpoint,
    schema_version:1,
    run_status:"generating",
    completed_cities:completed,
    city_attempts:attempts,
    last_error:null,
    started_at:newRun ? new Date().toISOString() : (checkpoint.started_at || new Date().toISOString()),
    updated_at:new Date().toISOString()
  };

  const updated = await patchOwnedTrip(tripId, session.user_id, {
    status:"generating",
    generation_count:nextRuns,
    itinerary_data:nextCheckpoint
  });

  return res.status(200).json({
    ok:true,
    action:"generation_begin",
    already_completed:false,
    new_run:newRun,
    max_generation_runs:MAX_GENERATION_RUNS,
    trip:updated
  });
}

async function handleGenerationCheckpoint(res, body, session) {
  const tripId = String(body.trip_id || "").trim();
  const status = String(body.status || "generating").trim().toLowerCase();
  const checkpoint = generationCheckpoint(body.checkpoint);

  if (!tripId) {
    return res.status(400).json({ ok:false, error:"Trip ID is required" });
  }
  if (!["generating", "failed", "generated"].includes(status)) {
    return res.status(400).json({ ok:false, error:"Invalid generation status" });
  }

  const trip = await getOwnedTripForGeneration(tripId, session.user_id);
  if (!trip) {
    return res.status(404).json({ ok:false, error:"Trip not found" });
  }
  if (!(await hasGenerationEntitlement(tripId, session.user_id))) {
    return res.status(402).json({ ok:false, code:"GENERATION_PAYMENT_REQUIRED", error:"Payment required" });
  }
  if (trip.status === "archived") {
    return res.status(409).json({ ok:false, code:"GENERATION_ARCHIVED", error:"Trip archived" });
  }
  if (trip.status === "generated" && status !== "generated") {
    return res.status(409).json({ ok:false, code:"GENERATION_ALREADY_COMPLETED", error:"Generation already completed" });
  }

  const destinations = Array.isArray(trip.destinations) ? trip.destinations : [];
  const expectedCities = destinations.map(x => String(x?.city || "").trim()).filter(Boolean);
  const completedCities = Array.isArray(checkpoint.completed_cities)
    ? checkpoint.completed_cities.map(String)
    : [];

  if (status === "generated" && !expectedCities.every(city => completedCities.includes(city))) {
    return res.status(400).json({
      ok:false,
      code:"GENERATION_INCOMPLETE",
      error:"Not every destination is complete"
    });
  }

  const now = new Date().toISOString();
  const persistedCheckpoint = {
    ...checkpoint,
    schema_version:1,
    run_status:status,
    updated_at:now,
    ...(status === "generated" ? { completed_at:now, last_error:null } : {})
  };

  const updated = await patchOwnedTrip(tripId, session.user_id, {
    status,
    itinerary_data:persistedCheckpoint,
    ...(status === "generated" ? { generated_at:now } : {})
  });

  return res.status(200).json({
    ok:true,
    action:"generation_checkpoint",
    trip:updated
  });
}

async function handlePostPaymentCheckpoint(res, body, session) {
  const tripId = String(body.trip_id || "").trim();
  const checkpoint = generationCheckpoint(body.checkpoint);

  if (!tripId) {
    return res.status(400).json({ ok:false, error:"Trip ID is required" });
  }

  const trip = await getOwnedTripForGeneration(tripId, session.user_id);
  if (!trip) {
    return res.status(404).json({ ok:false, error:"Trip not found" });
  }
  if (!(await hasGenerationEntitlement(tripId, session.user_id))) {
    return res.status(402).json({ ok:false, code:"GENERATION_PAYMENT_REQUIRED", error:"Payment required" });
  }
  if (trip.status === "archived") {
    return res.status(409).json({ ok:false, code:"GENERATION_ARCHIVED", error:"Trip archived" });
  }

  const plannerInput = generationCheckpoint(trip.planner_input);
  const persistedCheckpoint = {
    ...checkpoint,
    schema_version:1,
    updated_at:new Date().toISOString()
  };

  const updated = await patchOwnedTrip(tripId, session.user_id, {
    planner_input:{
      ...plannerInput,
      post_payment_progress:persistedCheckpoint
    }
  });

  return res.status(200).json({
    ok:true,
    action:"post_payment_checkpoint",
    trip:updated
  });
}

async function handleRecoverable(res, session) {
  const rows = await supabaseFetch(
    `/trips?select=id,status,destinations,planner_input,itinerary_data,generation_count,` +
    `generated_at,created_at,updated_at&user_id=eq.${encodeURIComponent(session.user_id)}&` +
    `status=in.(saved,generating,failed,generated)&order=updated_at.desc&limit=10`,
    { method:"GET" }
  );

  const candidates = Array.isArray(rows) ? rows : [];
  for (const trip of candidates) {
    if (trip?.id && await hasGenerationEntitlement(trip.id, session.user_id)) {
      return res.status(200).json({ ok:true, action:"recoverable", trip });
    }
  }

  return res.status(200).json({ ok:true, action:"recoverable", trip:null });
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

    const action =
      String(body.action || "")
        .trim()
        .toLowerCase();

    const sessionToken =
      String(body.session_token || "").trim();

    if (!sessionToken) {
      return res.status(401).json({
        ok: false,
        error: "Session required"
      });
    }

    const session =
      await getActiveSession(sessionToken);

    if (!session) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or expired session"
      });
    }

    if (action === "create") {
      return await handleCreate(res, body, session);
    }

    if (action === "update") {
      return await handleUpdate(res, body, session);
    }

    if (action === "get") {
      return await handleGet(res, body, session);
    }

    if (action === "archive") {
      return await handleArchive(res, body, session);
    }

    if (action === "generation_begin") {
      return await handleGenerationBegin(res, body, session);
    }

    if (action === "generation_checkpoint") {
      return await handleGenerationCheckpoint(res, body, session);
    }

    if (action === "post_payment_checkpoint") {
      return await handlePostPaymentCheckpoint(res, body, session);
    }

    if (action === "recoverable") {
      return await handleRecoverable(res, session);
    }

    return res.status(400).json({
      ok: false,
      error: "Unknown action"
    });
  } catch (error) {
    console.error("ITBMO trip endpoint error:", error);

    return res.status(500).json({
      ok: false,
      error: "Unexpected server error"
    });
  }
}
