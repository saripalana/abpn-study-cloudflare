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

export function examCountdownText(value, now = new Date()) {
  const days = daysUntilExam(value, now);
  if (days == null) return "Set test date";
  if (days === 0) return "Exam day";
  if (days === 1) return "1 day";
  if (days > 1) return `${days} days`;
  return `${Math.abs(days)} day${days === -1 ? "" : "s"} past`;
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
  render();
}
