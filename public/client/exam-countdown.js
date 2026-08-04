export const EXAM_DATE_KEY = "abpn-study:exam-date";

export function normalizeExamDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    ? `${year}-${month}-${day}`
    : "";
}

export function daysUntilExam(value, now = new Date()) {
  const normalized = normalizeExamDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

export function timeUntilExam(value, now = new Date()) {
  const normalized = normalizeExamDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split("-").map(Number);
  const target = new Date(year, month - 1, day);
  const milliseconds = target.getTime() - now.getTime();
  const absoluteMinutes = Math.floor(Math.abs(milliseconds) / 60_000);
  return {
    milliseconds,
    days: Math.floor(absoluteMinutes / 1_440),
    hours: Math.floor((absoluteMinutes % 1_440) / 60),
    minutes: absoluteMinutes % 60,
    sameLocalDay: target.getFullYear() === now.getFullYear()
      && target.getMonth() === now.getMonth()
      && target.getDate() === now.getDate(),
  };
}

export function examCountdownText(value, now = new Date()) {
  const remaining = timeUntilExam(value, now);
  if (!remaining) return "Set test date";
  if (remaining.sameLocalDay) return "Exam day";
  const duration = `${remaining.days}d ${remaining.hours}h ${remaining.minutes}m`;
  return remaining.milliseconds > 0 ? duration : `${duration} past`;
}

export function initExamCountdown({ documentRef = document, storage = localStorage, now = () => new Date() } = {}) {
  const openButton = documentRef.getElementById("examCountdownOpen");
  const valueLabel = documentRef.getElementById("examCountdownValue");
  const dateLabel = documentRef.getElementById("examCountdownDate");
  const dialog = documentRef.getElementById("examDateDialog");
  const input = documentRef.getElementById("examDateInput");
  const saveButton = documentRef.getElementById("saveExamDate");
  const clearButton = documentRef.getElementById("clearExamDate");
  const cancelButton = documentRef.getElementById("cancelExamDate");
  if (!openButton || !valueLabel || !dateLabel || !dialog || !input || !saveButton || !clearButton || !cancelButton) return;

  const render = () => {
    const saved = normalizeExamDate(storage.getItem(EXAM_DATE_KEY));
    valueLabel.textContent = examCountdownText(saved, now());
    dateLabel.textContent = saved ? new Date(`${saved}T12:00:00`).toLocaleDateString([], {
      year: "numeric", month: "short", day: "numeric",
    }) : "Local only";
    input.value = saved;
    clearButton.hidden = !saved;
  };
  // Update visible hours and minutes without changing the saved date.
  const refreshTimer = setInterval(render, 60_000);
  const close = () => typeof dialog.close === "function" ? dialog.close() : dialog.removeAttribute("open");

  openButton.addEventListener("click", () => {
    render();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  });
  saveButton.addEventListener("click", () => {
    const value = normalizeExamDate(input.value);
    if (!value) {
      input.setCustomValidity("Choose a valid test date.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    storage.setItem(EXAM_DATE_KEY, value);
    render();
    close();
  });
  clearButton.addEventListener("click", () => {
    storage.removeItem(EXAM_DATE_KEY);
    render();
    close();
  });
  cancelButton.addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  globalThis.addEventListener?.("pagehide", () => clearInterval(refreshTimer), { once: true });
  // The static button starts disabled so a fast click cannot race module setup.
  openButton.disabled = false;
  render();
}
