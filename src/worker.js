// API бронирования комнаты. Статика (public/) отдаётся Cloudflare напрямую,
// сюда попадают только запросы, для которых нет файла, то есть /api/*.

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // без 0/O, 1/I/L
const CODE_LENGTH = 6;
const MAX_APARTMENTS_PER_REQUEST = 1000;
const CODES_PER_INSERT = 50;

// Защита от подбора. Неудачи считаются в окне: через час без ошибок счётчик обнуляется.
// Лимит на IP останавливает перебор с одного устройства, лимит на квартиру — перебор
// с многих устройств. Порог на квартиру выше, чтобы соседу было трудно её «заблокировать».
const FAILURE_WINDOW = 60 * 60;
const LIMITS = {
  ip: { max: 20, lock: 30 * 60 },
  apt: { max: 30, lock: 15 * 60 },
  admin: { max: 10, lock: 30 * 60 },
};

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
      // Только JSON: так чужой сайт не сможет отправить запрос простой HTML-формой
      if (request.method === "POST" &&
          !(request.headers.get("Content-Type") || "").startsWith("application/json")) {
        throw new HttpError(415, "bad_request");
      }
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
    "POST /api/admin/settings": adminOnly(adminSaveSettings),
    "GET /api/admin/export": adminOnly(adminExport),
  };
  return routes[`${method} ${path}`];
}

// ---------- Публичное API ----------

async function getState(request, env, url) {
  const { today, maxDate } = bookingWindow(env);
  const month = url.searchParams.get("month") || today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "invalid_month");
  // Брони и настройки — одним обращением к базе
  const [bookings, settingsRows] = await env.DB.batch([
    env.DB.prepare("SELECT date, apartment FROM bookings WHERE month = ? ORDER BY date").bind(month),
    settingsQuery(env),
  ]);
  return {
    today, minDate: today, maxDate, month,
    bookings: bookings.results,
    settings: parseSettings(settingsRows.results),
    tzOffset: tzOffsetHours(env),
  };
}

async function book(request, env) {
  const { apartment, code, date } = await readBody(request);
  const label = normalizeLabel(apartment);
  checkBookableDate(env, date);
  await verifyCode(request, env, label, code);
  await insertBooking(env, label, date);
  return { ok: true, date, apartment: label };
}

async function cancel(request, env) {
  const { apartment, code, date } = await readBody(request);
  const label = normalizeLabel(apartment);
  if (!isValidDate(date)) throw new HttpError(400, "invalid_date");
  await verifyCode(request, env, label, code);
  const { today } = bookingWindow(env);
  if (date < today) throw new HttpError(400, "past_cancel");
  // Житель может отменить не позже чем за cancelHours до начала дня брони (по местному времени)
  const { cancelHours } = await getSettings(env);
  const dayStartUtc = Date.parse(`${date}T00:00:00Z`) - tzOffsetHours(env) * 3600_000;
  if (cancelHours > 0 && Date.now() > dayStartUtc - cancelHours * 3600_000) {
    throw new HttpError(400, "cancel_too_late", { hours: cancelHours });
  }
  const res = await env.DB.prepare("DELETE FROM bookings WHERE date = ? AND apartment = ?")
    .bind(date, label).run();
  if (!res.meta.changes) throw new HttpError(404, "no_own_booking");
  return { ok: true };
}

// Правила «один день — одна бронь» и «квартира — раз в месяц» держат ограничения таблицы,
// поэтому сначала просто вставляем, а причину отказа выясняем только при ошибке
async function insertBooking(env, label, date) {
  const month = date.slice(0, 7);
  try {
    await env.DB.prepare("INSERT INTO bookings (date, month, apartment) VALUES (?, ?, ?)")
      .bind(date, month, label).run();
  } catch (err) {
    if (!String(err).includes("UNIQUE")) throw err;
    const [taken, own] = await env.DB.batch([
      env.DB.prepare("SELECT apartment FROM bookings WHERE date = ?").bind(date),
      env.DB.prepare("SELECT date FROM bookings WHERE apartment = ? AND month = ?").bind(label, month),
    ]);
    if (taken.results[0]) throw new HttpError(409, "day_taken", { apt: taken.results[0].apartment });
    if (own.results[0]) throw new HttpError(409, "month_taken", { apt: label, date: own.results[0].date });
    throw new HttpError(409, "race");
  }
}

// ---------- Админка ----------

function adminOnly(handler) {
  return async (request, env, url) => {
    if (!env.ADMIN_PASSWORD) {
      throw new HttpError(503, "admin_disabled");
    }
    const key = `admin:${clientIp(request)}`;
    await checkLock(env, [key]);
    const given = request.headers.get("X-Admin-Password") || "";
    if (!(await safeEqual(given, env.ADMIN_PASSWORD))) {
      await registerFailure(env, key, LIMITS.admin);
      throw new HttpError(403, "wrong_password");
    }
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
  for (const label of wanted) {
    if (existing.has(label) && !overwrite) skipped.push(label);
    else created.push({ apartment: label, code: generateCode() });
  }
  const hashes = await Promise.all(created.map((c) => hashCode(c.apartment, c.code)));

  // На бесплатном тарифе D1 — не больше 50 запросов за вызов и 100 параметров в запросе,
  // поэтому пишем по 50 квартир одним INSERT (2 параметра на квартиру), всё одной транзакцией
  const statements = [];
  for (let i = 0; i < created.length; i += CODES_PER_INSERT) {
    const chunk = created.slice(i, i + CODES_PER_INSERT);
    statements.push(env.DB.prepare(`
      INSERT INTO apartments (label, code_hash) VALUES ${chunk.map(() => "(?, ?)").join(", ")}
      ON CONFLICT(label) DO UPDATE SET code_hash = excluded.code_hash, updated_at = datetime('now')
    `).bind(...chunk.flatMap((c, j) => [c.apartment, hashes[i + j]])));
  }
  if (statements.length) await env.DB.batch(statements);
  created.sort((a, b) => naturalCompare(a.apartment, b.apartment));
  return { created, skipped: skipped.sort(naturalCompare) };
}

async function adminRegenerate(request, env) {
  const label = normalizeLabel((await readBody(request)).apartment);
  await requireApartment(env, label);
  const code = generateCode();
  await upsertCodeStatement(env, label, await hashCode(label, code)).run();
  await env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind(`apt:${label}`).run();
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

async function adminExport(request, env) {
  const offset = `${tzOffsetHours(env) >= 0 ? "+" : ""}${tzOffsetHours(env)} hours`;
  const { results } = await env.DB.prepare(
    "SELECT date, apartment, datetime(created_at, ?) AS created_at FROM bookings ORDER BY date"
  ).bind(offset).all();
  return { bookings: results };
}

// ---------- Настройки ----------

const DEFAULT_SETTINGS = { whatsapp: "", rules: { ru: "", kk: "", en: "" }, cancelHours: 24 };
const MAX_RULES_LENGTH = 3000;

function settingsQuery(env) {
  return env.DB.prepare("SELECT key, value FROM settings");
}

async function getSettings(env) {
  return parseSettings((await settingsQuery(env).all()).results);
}

function parseSettings(rows) {
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    rules: { ...DEFAULT_SETTINGS.rules, ...(stored.rules || {}) },
  };
}

async function adminSaveSettings(request, env) {
  const body = await readBody(request);

  // Казахстанский номер: «8 701 …» превращаем в «7701…», для wa.me нужны только цифры
  let whatsapp = String(body.whatsapp ?? "").replace(/\D/g, "");
  if (whatsapp.length === 11 && whatsapp.startsWith("8")) whatsapp = "7" + whatsapp.slice(1);
  if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 15)) {
    throw new HttpError(400, "invalid_phone");
  }

  const cancelHours = Number(body.cancelHours);
  if (!Number.isInteger(cancelHours) || cancelHours < 0 || cancelHours > 168) {
    throw new HttpError(400, "invalid_hours");
  }

  const rules = {};
  for (const lang of ["ru", "kk", "en"]) {
    const text = String(body.rules?.[lang] ?? "").trim();
    if (text.length > MAX_RULES_LENGTH) throw new HttpError(400, "rules_too_long", { max: MAX_RULES_LENGTH });
    rules[lang] = text;
  }

  const settings = { whatsapp, cancelHours, rules };
  await env.DB.batch(Object.entries(settings).map(([key, value]) =>
    env.DB.prepare(`
      INSERT INTO settings (key, value) VALUES (?1, ?2)
      ON CONFLICT(key) DO UPDATE SET value = ?2
    `).bind(key, JSON.stringify(value))));
  return { ok: true, settings };
}

// ---------- Коды и защита от подбора ----------

async function verifyCode(request, env, label, code) {
  const ipKey = `ip:${clientIp(request)}`;
  const aptKey = `apt:${label}`;
  // Проверка блокировки и хэш кода — одним обращением к базе
  const [lock, apt] = await env.DB.batch([
    lockQuery(env, [ipKey, aptKey]),
    env.DB.prepare("SELECT code_hash FROM apartments WHERE label = ?").bind(label),
  ]);
  throwIfLocked(lock.results);
  const row = apt.results[0];
  const given = normalizeCode(code);
  const ok = row && given && (await safeEqual(await hashCode(label, given), row.code_hash));
  if (!ok) {
    await registerFailure(env, ipKey, LIMITS.ip);
    if (row) await registerFailure(env, aptKey, LIMITS.apt);
    throw new HttpError(403, "wrong_code");
  }
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "local";
}

async function checkLock(env, keys) {
  throwIfLocked((await lockQuery(env, keys).all()).results);
}

function lockQuery(env, keys) {
  return env.DB.prepare(
    `SELECT MAX(locked_until) AS until FROM attempts WHERE key IN (${keys.map(() => "?").join(",")})`
  ).bind(...keys);
}

function throwIfLocked(results) {
  const now = Math.floor(Date.now() / 1000);
  const until = results[0]?.until || 0;
  if (until > now) {
    throw new HttpError(429, "locked", { minutes: Math.ceil((until - now) / 60) });
  }
}

async function registerFailure(env, key, { max, lock }) {
  const now = Math.floor(Date.now() / 1000);
  // Старые ошибки (раньше чем час назад) не считаются; при достижении порога — блокировка
  await env.DB.prepare(`
    INSERT INTO attempts (key, failures, locked_until, last_failure) VALUES (?1, 1, 0, ?2)
    ON CONFLICT(key) DO UPDATE SET
      failures = CASE
        WHEN last_failure < ?2 - ?3 THEN 1
        WHEN failures + 1 >= ?4 THEN 0
        ELSE failures + 1 END,
      locked_until = CASE
        WHEN last_failure >= ?2 - ?3 AND failures + 1 >= ?4 THEN ?2 + ?5
        ELSE locked_until END,
      last_failure = ?2
  `).bind(key, now, FAILURE_WINDOW, max, lock).run();
  // Иногда подчищаем давно неактивные записи, чтобы таблица не росла
  if (Math.random() < 0.05) {
    await env.DB.prepare("DELETE FROM attempts WHERE last_failure < ?1 AND locked_until < ?2")
      .bind(now - 86400, now).run();
  }
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

function tzOffsetHours(env) {
  return Number(env.TZ_OFFSET_HOURS ?? 5);
}

function bookingWindow(env) {
  const monthsAhead = Number(env.MONTHS_AHEAD ?? 1);
  const local = new Date(Date.now() + tzOffsetHours(env) * 3600_000);
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
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
