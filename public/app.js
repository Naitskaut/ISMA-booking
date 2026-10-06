import {
  api, cancelDeadline, el, longDate, monthCells, monthName, monthTitle, rulesFor, setupChrome, shiftMonth, store, t,
  toast, whatsappUrl,
} from "./common.js";
import { onLangChange } from "./i18n.js";

const MONTHS_BACK = 12; // насколько далеко можно листать историю

const grid = document.getElementById("grid");
const list = document.getElementById("list");
const dlg = document.getElementById("dlg");
const dlgBody = document.getElementById("dlg-body");
const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");

let state = null;   // ответ /api/state для текущего месяца
let month = null;

setupChrome();
onLangChange(() => {
  if (state) render();
  if (dlg.open) dlg.close();
});

prevBtn.addEventListener("click", () => load(shiftMonth(month, -1)));
nextBtn.addEventListener("click", () => load(shiftMonth(month, 1)));
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

async function load(m) {
  try {
    state = await api(`/api/state${m ? `?month=${m}` : ""}`);
    month = state.month;
    render();
  } catch (err) {
    grid.replaceChildren(el("p", { class: "empty-note" }, err.message));
  }
}

function render() {
  const { today, minDate, maxDate, bookings } = state;
  const byDate = new Map(bookings.map((b) => [b.date, b.apartment]));

  document.getElementById("month-title").textContent = monthTitle(month);
  document.getElementById("weekdays").replaceChildren(...t("weekdaysShort").map((d) => el("div", {}, d)));
  prevBtn.disabled = month <= shiftMonth(today.slice(0, 7), -MONTHS_BACK);
  nextBtn.disabled = month >= maxDate.slice(0, 7);

  grid.replaceChildren(...monthCells(month).map((date) => {
    if (!date) return el("div", { class: "day empty" });
    const apt = byDate.get(date);
    const bookable = date >= minDate && date <= maxDate;
    const cls = ["day"];
    if (date < today) cls.push("past");
    if (date === today) cls.push("today");
    if (apt) cls.push("taken");
    else if (bookable) cls.push("free");
    if (apt && bookable) cls.push("clickable");

    const label = apt ? t("ariaTaken", { date: longDate(date), apt })
      : bookable ? t("ariaFree", { date: longDate(date) }) : longDate(date);
    return el(bookable ? "button" : "div",
      { class: cls.join(" "), "aria-label": label, onclick: bookable ? () => openDay(date, apt) : null },
      el("span", { class: "num" }, String(Number(date.slice(8)))),
      apt ? el("span", { class: "who" }, t("aptShort", { apt }))
        : bookable ? el("span", { class: "who" }, t("free")) : null,
    );
  }));

  document.getElementById("list-title").textContent = t("bookingsOf", { month: monthName(month) });
  list.replaceChildren(...(bookings.length
    ? bookings.map((b) => el("li", {},
        el("span", { class: "date" }, longDate(b.date)),
        el("span", { class: "apt" }, t("aptShort", { apt: b.apartment }))))
    : [el("li", {}, el("span", { class: "empty-note" }, t("noBookings")))]));

  renderSettings(state.settings);
}

// Правила и кнопка WhatsApp показываются, только если админ их заполнил
function renderSettings(settings) {
  const rules = rulesFor(settings);
  document.getElementById("rules").hidden = rules.length === 0;
  document.getElementById("rules-list").replaceChildren(...rules.map((r) => el("li", {}, r)));

  const phone = settings?.whatsapp;
  document.getElementById("help").hidden = !phone;
  if (phone) document.getElementById("wa-link").href = whatsappUrl(phone);
}

function openDay(date, apt) {
  if (apt) openBooked(date, apt);
  else openFree(date);
  dlg.showModal();
}

function openFree(date) {
  const aptInput = el("input", { type: "text", id: "f-apt", autocomplete: "off",
    required: true, value: store.get("apartment") || "", placeholder: t("aptPh") });
  const codeInput = el("input", { type: "text", id: "f-code", class: "code", autocomplete: "off",
    required: true, maxlength: "12", placeholder: t("codePh") });
  const error = el("div", { class: "error", hidden: true });
  const submit = el("button", { class: "btn primary", type: "submit" }, t("bookBtn"));

  const form = el("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        const res = await api("/api/book", { method: "POST",
          body: { apartment: aptInput.value, code: codeInput.value, date } });
        store.set("apartment", res.apartment);
        dlg.close();
        toast(t("bookedOk", { date: longDate(date), apt: res.apartment }));
        await load(month);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        if (err.status === 409) await load(month);
      } finally {
        submit.disabled = false;
      }
    },
  },
    el("h3", {}, t("bookTitle")),
    el("p", { class: "sub" }, longDate(date)),
    el("label", { for: "f-apt" }, t("aptLabel")), aptInput,
    el("label", { for: "f-code" }, t("codeLabel")), codeInput,
    el("p", { class: "hint" }, t("codeHint")),
    error,
    el("div", { class: "actions" },
      el("button", { class: "btn", type: "button", onclick: () => dlg.close() }, t("close")),
      submit),
  );
  dlgBody.replaceChildren(form);
  setTimeout(() => (aptInput.value ? codeInput : aptInput).focus(), 0);
}

function openBooked(date, apt) {
  const codeInput = el("input", { type: "text", id: "c-code", class: "code", autocomplete: "off",
    required: true, maxlength: "12", placeholder: t("codePh") });
  const error = el("div", { class: "error", hidden: true });
  const submit = el("button", { class: "btn danger", type: "submit" }, t("cancelBtn"));

  const form = el("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        await api("/api/cancel", { method: "POST", body: { apartment: apt, code: codeInput.value, date } });
        dlg.close();
        toast(t("cancelled", { date: longDate(date) }));
        await load(month);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    el("label", { for: "c-code" }, t("codeFor", { apt })), codeInput,
    error,
    el("div", { class: "actions" }, submit),
  );

  dlgBody.replaceChildren(
    el("h3", {}, t("takenTitle", { apt })),
    el("p", { class: "sub" }, longDate(date)),
    el("details", {}, el("summary", {}, t("yourBooking")), ...cancelContent(date, form)),
    el("div", { class: "actions" },
      el("button", { class: "btn", type: "button", onclick: () => dlg.close() }, t("close"))),
  );
}

load();

// Пока срок не вышел — подсказка «можно до …» и форма; после — просьба написать администратору
function cancelContent(date, form) {
  const hours = state.settings?.cancelHours || 0;
  if (!hours) return [form];
  const [y, m, d] = date.split("-").map(Number);
  const closesAt = Date.UTC(y, m - 1, d) - ((state.tzOffset ?? 5) + hours) * 3600_000;
  if (Date.now() <= closesAt) {
    return [el("p", { class: "note" }, t("cancelUntil", { when: cancelDeadline(date, hours) })), form];
  }
  const phone = state.settings?.whatsapp;
  return [
    el("p", { class: "note" }, t("cancelClosed", { hours })),
    phone ? el("a", { class: "wa-link", href: whatsappUrl(phone), target: "_blank", rel: "noopener noreferrer" },
      document.querySelector("#wa-link svg").cloneNode(true), el("span", {}, t("contactAdmin"))) : null,
  ];
}
