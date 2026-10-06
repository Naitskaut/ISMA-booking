// API бронирования комнаты. Статика (public/) отдаётся Cloudflare напрямую,
// сюда попадают только запросы, для которых нет файла, то есть /api/*.

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // без 0/O, 1/I/L
const CODE_LENGTH = 6;
const MAX_FAILURES = 10;
const LOCK_SECONDS = 15 * 60;
const MAX_APARTMENTS_PER_REQUEST = 2000;

// Ошибки отдаются кодом, текст на нужном языке подставляет сайт (public/i18n.js)
class HttpError extends Error {
  constructor(status, code, params = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const handler = route(request.method, url.pathname);
      if (!handler) throw new HttpError(404, "not_found");
      return json(await handler(request, env, url));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code, params: err.params }, err.status);
      console.error(err);
      return json({ error: "server_error" }, 500);
    }
  },
};

function route(method, path) {
  const routes = {
    "GET /api/state": getState,
    "POST /api/book": book,
    "POST /api/cancel": cancel,
    "POST /api/admin/login": adminOnly(adminLogin),
    "GET /api/admin/apartments": adminOnly(adminListApartments),
    "POST /api/admin/apartments": adminOnly(adminAddApartments),
    "POST /api/admin/apartments/regenerate": adminOnly(adminRegenerate),
    "POST /api/admin/apartments/delete": adminOnly(adminDeleteApartment),
    "POST /api/admin/book": adminOnly(adminBook),
    "POST /api/admin/cancel": adminOnly(adminCancel),
  };
  return routes[`${method} ${path}`];
}

// ---------- Публичное API ----------

async function getState(request, env, url) {
  const { today, maxDate } = bookingWindow(env);
  const month = url.searchParams.get("month") || today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "invalid_month");
  const { results } = await env.DB.prepare(
    "SELECT date, apartment FROM bookings WHERE month = ? ORDER BY date"
  ).bind(month).all();
  return { today, minDate: today, maxDate, month, bookings: results };
}

async function book(request, env) {
  const { apartment, code, date } = await readBody(request);
  const label = normalizeLabel(apartment);
  checkBookableDate(env, date);
  await verifyCode(env, label, code);
  await insertBooking(env, label, date);
  return { ok: true, date, apartment: label };
}

async function cancel(request, env) {
  const { apartment, code, date } = await readBody(request);
  const label = normalizeLabel(apartment);
  if (!isValidDate(date)) throw new HttpError(400, "invalid_date");
  await verifyCode(env, label, code);
  const { today } = bookingWindow(env);
  if (date < today) throw new HttpError(400, "past_cancel");
  const res = await env.DB.prepare("DELETE FROM bookings WHERE date = ? AND apartment = ?")
    .bind(date, label).run();
  if (!res.meta.changes) throw new HttpError(404, "no_own_booking");
  return { ok: true };
}

async function insertBooking(env, label, date) {
  const month = date.slice(0, 7);
  const taken = await env.DB.prepare("SELECT apartment FROM bookings WHERE date = ?")
    .bind(date).first();
  if (taken) throw new HttpError(409, "day_taken", { apt: taken.apartment });
  const own = await env.DB.prepare("SELECT date FROM bookings WHERE apartment = ? AND month = ?")
    .bind(label, month).first();
  if (own) {
    throw new HttpError(409, "month_taken", { apt: label, date: own.date });
  }
  try {
    await env.DB.prepare("INSERT INTO bookings (date, month, apartment) VALUES (?, ?, ?)")
      .bind(date, month, label).run();
  } catch (err) {
    // Кто-то успел забронировать одновременно с нами — ограничения таблицы это поймали
    if (String(err).includes("UNIQUE")) {
      throw new HttpError(409, "race");
    }
    throw err;
  }
}

// ---------- Админка ----------

function adminOnly(handler) {
  return async (request, env, url) => {
    if (!env.ADMIN_PASSWORD) {
      throw new HttpError(503, "admin_disabled");
    }
    const key = `admin:${request.headers.get("CF-Connecting-IP") || "local"}`;
    await checkLock(env, key);
    const given = request.headers.get("X-Admin-Password") || "";
    if (!(await safeEqual(given, env.ADMIN_PASSWORD))) {
      await registerFailure(env, key);
      throw new HttpError(403, "wrong_password");
    }
    await clearFailures(env, key);
    return handler(request, env, url);
  };
}

async function adminLogin(request, env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM apartments").first();
  return { ok: true, apartments: row.n };
}

async function adminListApartments(request, env) {
  const { results } = await env.DB.prepare("SELECT label FROM apartments").all();
  const labels = results.map((r) => r.label).sort(naturalCompare);
  return { apartments: labels };
}

async function adminAddApartments(request, env) {
  const { labels, overwrite } = await readBody(request);
  if (!Array.isArray(labels) || labels.length === 0) throw new HttpError(400, "empty_list");
  if (labels.length > MAX_APARTMENTS_PER_REQUEST) {
    throw new HttpError(400, "too_many", { max: MAX_APARTMENTS_PER_REQUEST });
  }
  const wanted = [...new Set(labels.map(normalizeLabel))];
  const { results } = await env.DB.prepare("SELECT label FROM apartments").all();
  const existing = new Set(results.map((r) => r.label));

  const created = [];
  const skipped = [];
  const statements = [];
  for (const label of wanted) {
    if (existing.has(label) && !overwrite) {
      skipped.push(label);
      continue;
    }
    const code = generateCode();
    created.push({ apartment: label, code });
    statements.push(upsertCodeStatement(env, label, await hashCode(label, code)));
  }
  // D1 выполняет batch одной транзакцией
  for (let i = 0; i < statements.length; i += 500) {
    await env.DB.batch(statements.slice(i, i + 500));
  }
  created.sort((a, b) => naturalCompare(a.apartment, b.apartment));
  return { created, skipped: skipped.sort(naturalCompare) };
}

async function adminRegenerate(request, env) {
  const label = normalizeLabel((await readBody(request)).apartment);
  await requireApartment(env, label);
  const code = generateCode();
  await upsertCodeStatement(env, label, await hashCode(label, code)).run();
  await clearFailures(env, `apt:${label}`);
  return { apartment: label, code };
}

async function adminDeleteApartment(request, env) {
  const label = normalizeLabel((await readBody(request)).apartment);
  await requireApartment(env, label);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bookings WHERE apartment = ?").bind(label),
    env.DB.prepare("DELETE FROM apartments WHERE label = ?").bind(label),
  ]);
  return { ok: true };
}

async function adminBook(request, env) {
  const { apartment, date } = await readBody(request);
  const label = normalizeLabel(apartment);
  checkBookableDate(env, date);
  await requireApartment(env, label);
  await insertBooking(env, label, date);
  return { ok: true, date, apartment: label };
}

async function adminCancel(request, env) {
  const { date } = await readBody(request);
  if (!isValidDate(date)) throw new HttpError(400, "invalid_date");
  const res = await env.DB.prepare("DELETE FROM bookings WHERE date = ?").bind(date).run();
  if (!res.meta.changes) throw new HttpError(404, "no_booking");
  return { ok: true };
}

// ---------- Коды и защита от подбора ----------

async function verifyCode(env, label, code) {
  const key = `apt:${label}`;
  await checkLock(env, key);
  const row = await env.DB.prepare("SELECT code_hash FROM apartments WHERE label = ?")
    .bind(label).first();
  const given = normalizeCode(code);
  const ok = row && given && (await safeEqual(await hashCode(label, given), row.code_hash));
  if (!ok) {
    if (row) await registerFailure(env, key);
    throw new HttpError(403, "wrong_code");
  }
  await clearFailures(env, key);
}

async function checkLock(env, key) {
  const row = await env.DB.prepare("SELECT locked_until FROM attempts WHERE key = ?")
    .bind(key).first();
  const now = Math.floor(Date.now() / 1000);
  if (row && row.locked_until > now) {
    const minutes = Math.ceil((row.locked_until - now) / 60);
    throw new HttpError(429, "locked", { minutes });
  }
}

async function registerFailure(env, key) {
  const lockUntil = Math.floor(Date.now() / 1000) + LOCK_SECONDS;
  await env.DB.prepare(`
    INSERT INTO attempts (key, failures, locked_until) VALUES (?1, 1, 0)
    ON CONFLICT(key) DO UPDATE SET
      locked_until = CASE WHEN failures + 1 >= ?2 THEN ?3 ELSE locked_until END,
      failures     = CASE WHEN failures + 1 >= ?2 THEN 0  ELSE failures + 1 END
  `).bind(key, MAX_FAILURES, lockUntil).run();
}

async function clearFailures(env, key) {
  await env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind(key).run();
}

function upsertCodeStatement(env, label, hash) {
  return env.DB.prepare(`
    INSERT INTO apartments (label, code_hash) VALUES (?1, ?2)
    ON CONFLICT(label) DO UPDATE SET code_hash = ?2, updated_at = datetime('now')
  `).bind(label, hash);
}

async function requireApartment(env, label) {
  const row = await env.DB.prepare("SELECT 1 FROM apartments WHERE label = ?").bind(label).first();
  if (!row) throw new HttpError(404, "apt_not_found", { apt: label });
}

function generateCode() {
  // Отбрасываем байты >= 248, чтобы все 31 символ были равновероятны
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return code;
}

async function hashCode(label, code) {
  return sha256Hex(`${label}:${code}`);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function safeEqual(a, b) {
  // Сравниваем хэши, чтобы время сравнения не зависело от совпавшего префикса
  const [ha, hb] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

// ---------- Даты и разбор ввода ----------

function bookingWindow(env) {
  const offsetHours = Number(env.TZ_OFFSET_HOURS ?? 5);
  const monthsAhead = Number(env.MONTHS_AHEAD ?? 1);
  const local = new Date(Date.now() + offsetHours * 3600_000);
  const today = local.toISOString().slice(0, 10);
  const lastDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + monthsAhead + 1, 0));
  return { today, maxDate: lastDay.toISOString().slice(0, 10) };
}

function checkBookableDate(env, date) {
  if (!isValidDate(date)) throw new HttpError(400, "invalid_date");
  const { today, maxDate } = bookingWindow(env);
  if (date < today) throw new HttpError(400, "past_day");
  if (date > maxDate) throw new HttpError(400, "too_far", { date: maxDate });
}

function isValidDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}


function normalizeLabel(value) {
  const label = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!label || label.length > 20 || !/^[0-9A-ZА-ЯЁ\-\/.]+$/.test(label)) {
    throw new HttpError(400, "invalid_apt");
  }
  return label;
}

function normalizeCode(value) {
  return String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
}

function naturalCompare(a, b) {
  return a.localeCompare(b, "ru", { numeric: true });
}

async function readBody(request) {
  try {
    const body = await request.json();
    if (body && typeof body === "object") return body;
  } catch {}
  throw new HttpError(400, "bad_request");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
