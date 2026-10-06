// Общие функции для календаря и админки
import { applyStatic, getLang, setLang, t, tErr } from "./i18n.js";

export async function api(path, { method = "GET", body, headers = {} } = {}) {
  let res;
  let data = {};
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    data = await res.json();
  } catch {}
  if (!res || !res.ok) {
    const err = new Error(tErr(data.error || "network", data.params));
    err.status = res?.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

export function monthTitle(month) {
  const [y, m] = month.split("-").map(Number);
  return `${t("months")[m - 1]} ${y}`;
}

export function monthName(month) {
  return t("months")[Number(month.split("-")[1]) - 1];
}

export function longDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  const wd = t("weekdays")[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${d} ${t("monthsGen")[m - 1]}, ${wd}`;
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

// Дни месяца с пустыми клетками в начале, неделя с понедельника
export function monthCells(month) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  return cells;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

let toastTimer;
export function toast(text) {
  document.querySelector(".toast")?.remove();
  const node = el("div", { class: "toast", role: "status" }, text);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3500);
}

export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

// Тема: тему из системы можно переопределить кнопкой, выбор запоминается
function currentTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Подключает переключатели языка и темы в шапке
export function setupChrome() {
  document.querySelectorAll("[data-lang]").forEach((b) =>
    b.addEventListener("click", () => setLang(b.dataset.lang)));
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  });
  applyStatic();
}

export { getLang, t };

// Подтверждение внутри страницы: системный confirm() блокируют некоторые браузеры
export function confirmDialog(text, okLabel = t("confirmOk")) {
  return new Promise((resolve) => {
    const dlg = el("dialog", {});
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(el("div", { class: "dlg" },
      el("p", { class: "question" }, text),
      el("div", { class: "actions" },
        el("button", { class: "btn", type: "button", onclick: () => done(false) }, t("confirmNo")),
        el("button", { class: "btn primary", type: "button", onclick: () => done(true) }, okLabel))));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// Правила на текущем языке; если он не заполнен — первый заполненный из остальных
export function rulesFor(settings, lang = getLang()) {
  const rules = settings?.rules || {};
  const text = [lang, "ru", "kk", "en"].map((l) => rules[l]).find((r) => r && r.trim());
  if (!text) return [];
  return text.split(/\r?\n/)
    .map((line) => line.trim().replace(/^([-–—•*]|\d+[.)])\s*/, ""))
    .filter(Boolean);
}

// Время, до которого житель может сам отменить бронь (местное время), или null
export function cancelDeadline(date, hours) {
  if (!hours) return null;
  const [y, m, d] = date.split("-").map(Number);
  const t0 = new Date(Date.UTC(y, m - 1, d) - hours * 3600_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(t0.getUTCDate())}.${pad(t0.getUTCMonth() + 1)} ${pad(t0.getUTCHours())}:00`;
}

export function whatsappUrl(phone) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(t("waText"))}`;
}
