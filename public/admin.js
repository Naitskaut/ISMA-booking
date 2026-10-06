import { api, confirmDialog, el, longDate, monthTitle, setupChrome, shiftMonth, t, toast } from "./common.js";
import { onLangChange, tErr } from "./i18n.js";

const $ = (id) => document.getElementById(id);

const session = {
  get() { try { return sessionStorage.getItem("adminPassword") || ""; } catch { return ""; } },
  set(v) { try { sessionStorage.setItem("adminPassword", v); } catch {} },
  clear() { try { sessionStorage.removeItem("adminPassword"); } catch {} },
};
let password = session.get();
let state = null;
const results = {}; // id блока -> { created, skipped }, чтобы перерисовать при смене языка

setupChrome();
onLangChange(() => {
  if (state) renderBookings();
  for (const [id, r] of Object.entries(results)) renderCodes(id, r.created, r.skipped);
  document.querySelectorAll(".error").forEach((e) => (e.hidden = true));
});

function adminApi(path, body) {
  return api(path, {
    method: body ? "POST" : "GET",
    body,
    headers: { "X-Admin-Password": password },
  }).catch((err) => {
    if (err.status === 403) logout();
    throw err;
  });
}

function showError(id, err) {
  const box = $(id);
  box.textContent = err ? err.message : "";
  box.hidden = !err;
}

// ---------- Вход ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  password = $("password").value;
  await login();
});

$("logout").addEventListener("click", logout);

async function login() {
  try {
    const res = await adminApi("/api/admin/login", {});
    session.set(password);
    showError("login-error", null);
    $("login-card").hidden = true;
    $("admin").hidden = false;
    $("logout").hidden = false;
    $("apt-count").textContent = res.apartments;
    await loadBookings();
    fillSettings(state.settings);
  } catch (err) {
    showError("login-error", err);
  }
}

function logout() {
  password = "";
  session.clear();
  $("admin").hidden = true;
  $("logout").hidden = true;
  $("login-card").hidden = false;
  $("password").value = "";
}

// ---------- Вкладки ----------

document.querySelectorAll("[role=tab]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll("[role=tab]").forEach((x) => x.setAttribute("aria-selected", x === tab));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  if (tab.dataset.tab === "apartments") loadApartments();
}));

// ---------- Брони ----------

$("prev").addEventListener("click", () => loadBookings(shiftMonth(state.month, -1)));
$("next").addEventListener("click", () => loadBookings(shiftMonth(state.month, 1)));

async function loadBookings(m) {
  state = await api(`/api/state${m ? `?month=${m}` : ""}`);
  $("ab-date").min = state.minDate;
  $("ab-date").max = state.maxDate;
  renderBookings();
}

function renderBookings() {
  $("month-title").textContent = monthTitle(state.month);
  const items = state.bookings.map((b) => el("li", {},
    el("span", {}, el("span", { class: "apt" }, t("aptShort", { apt: b.apartment })), " ",
      el("span", { class: "date" }, longDate(b.date))),
    el("button", { class: "btn danger small", onclick: () => adminCancel(b) }, t("adminCancel"))));
  $("bookings").replaceChildren(...(items.length ? items
    : [el("li", {}, el("span", { class: "empty-note" }, t("noBookingsMonth")))]));
}

async function adminCancel(b) {
  if (!await confirmDialog(t("confirmCancel", { apt: b.apartment, date: longDate(b.date) }))) return;
  try {
    await adminApi("/api/admin/cancel", { date: b.date });
    toast(t("cancelledShort"));
    await loadBookings(state.month);
  } catch (err) {
    toast(err.message);
  }
}

$("admin-book").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("ab-error", null);
  const date = $("ab-date").value;
  try {
    const res = await adminApi("/api/admin/book", { apartment: $("ab-apt").value, date });
    toast(t("adminBooked", { apt: res.apartment, date: longDate(date) }));
    $("ab-apt").value = "";
    await loadBookings(date.slice(0, 7));
  } catch (err) {
    showError("ab-error", err);
  }
});

$("export").addEventListener("click", async () => {
  try {
    const { bookings } = await adminApi("/api/admin/export");
    downloadFile(`isma-bookings-${new Date().toISOString().slice(0, 10)}.csv`,
      [t("exportHeader"), ...bookings.map((b) => `${b.date};${b.apartment};${b.created_at}`)]);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Настройки ----------

function fillSettings(settings) {
  $("s-wa").value = settings.whatsapp ? `+${settings.whatsapp}` : "";
  $("s-hours").value = settings.cancelHours;
  for (const lang of ["ru", "kk", "en"]) $(`s-rules-${lang}`).value = settings.rules[lang] || "";
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("settings-error", null);
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const res = await adminApi("/api/admin/settings", {
      whatsapp: $("s-wa").value,
      cancelHours: Number($("s-hours").value || 0),
      rules: { ru: $("s-rules-ru").value, kk: $("s-rules-kk").value, en: $("s-rules-en").value },
    });
    state.settings = res.settings;
    fillSettings(res.settings);
    toast(t("saved"));
  } catch (err) {
    showError("settings-error", err);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Квартиры ----------

async function loadApartments() {
  try {
    const { apartments } = await adminApi("/api/admin/apartments");
    $("apt-count").textContent = apartments.length;
    $("apt-list").replaceChildren(...apartments.map((a) => el("span", {}, a)));
  } catch (err) {
    toast(err.message);
  }
}

document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => {
  const range = document.querySelector("input[name=mode]:checked").value === "range";
  $("mode-range").hidden = !range;
  $("range-hint").hidden = !range;
  $("mode-list").hidden = range;
}));

function collectLabels() {
  const mode = document.querySelector("input[name=mode]:checked").value;
  if (mode === "list") {
    return $("l-text").value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  const from = Number($("r-from").value);
  const to = Number($("r-to").value);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error(tErr("bad_range"));
  }
  if (to - from >= 1000) throw new Error(tErr("too_many", { max: 1000 }));
  const prefix = $("r-prefix").value.trim();
  return Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("add-error", null);
  const overwrite = $("overwrite").checked;
  const btn = e.submitter;
  try {
    const labels = collectLabels();
    if (!labels.length) throw new Error(tErr("empty_list"));
    if (overwrite && !await confirmDialog(t("confirmOverwrite"))) return;
    btn.disabled = true;
    const res = await adminApi("/api/admin/apartments", { labels, overwrite });
    renderCodes("add-result", res.created, res.skipped);
    loadApartments();
  } catch (err) {
    showError("add-error", err);
  } finally {
    btn.disabled = false;
  }
});

$("one-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("one-error", null);
  $("one-result").hidden = true;
  delete results["one-result"];
  const apartment = $("one-apt").value;
  try {
    if (e.submitter.dataset.action === "delete") {
      if (!await confirmDialog(t("confirmDelete", { apt: apartment }))) return;
      await adminApi("/api/admin/apartments/delete", { apartment });
      toast(t("deleted", { apt: apartment }));
    } else {
      const res = await adminApi("/api/admin/apartments/regenerate", { apartment });
      renderCodes("one-result", [res], []);
    }
    loadApartments();
  } catch (err) {
    showError("one-error", err);
  }
});

function renderCodes(id, created, skipped) {
  results[id] = { created, skipped };
  const PREVIEW = 30;
  $(id).replaceChildren(...[
    created.length === 1
      ? el("p", { class: "flush" }, t("oneCode", { apt: created[0].apartment }), " ",
          el("strong", { class: "code" }, created[0].code))
      : el("p", { class: "flush" }, el("strong", {}, t("createdCount", { n: created.length }))),
    skipped.length ? el("p", { class: "hint" }, t("skipped", { n: skipped.length })) : null,
    created.length > 1
      ? el("div", { class: "codes" }, created.slice(0, PREVIEW).map((c) => el("div", {}, `${c.apartment} — ${c.code}`)),
          created.length > PREVIEW ? el("div", { class: "muted" }, t("andMore", { n: created.length - PREVIEW })) : null)
      : null,
    created.length ? el("p", { class: "hint" }, t("codesOnce")) : null,
    created.length
      ? el("div", { class: "actions start" },
          el("button", { class: "btn primary", onclick: () => printSlips(created) }, t("printSlips")),
          el("button", { class: "btn", onclick: () => downloadCsv(created) }, t("downloadCsv")))
      : null,
  ].filter(Boolean));
  $(id).hidden = false;
}

function downloadCsv(rows) {
  downloadFile(`isma-codes-${new Date().toISOString().slice(0, 10)}.csv`,
    [t("csvHeader"), ...rows.map((r) => `${r.apartment};${r.code}`)]);
}

// CSV с BOM и «;», чтобы Excel сразу открыл кириллицу по столбцам
function downloadFile(name, lines) {
  const csv = "﻿" + lines.join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Карточки для почтовых ящиков печатаются сразу на русском и казахском
function printSlips(rows) {
  const site = location.host;
  $("print-area").replaceChildren(...rows.map((r) => el("div", { class: "slip" },
    el("div", { class: "brand" }, "ISMA"),
    el("div", {}, "Бронь комнаты для мероприятий / Іс-шара бөлмесін брондау"),
    el("div", { class: "apt" }, `Квартира / Пәтер ${r.apartment}`),
    el("div", { class: "code" }, r.code),
    el("div", {}, site),
    el("div", {}, "1 раз в месяц на квартиру · Айына бір рет"))));
  window.print();
}

if (password) login();
