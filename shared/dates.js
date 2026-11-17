// Dates are stored and passed around as ISO strings "YYYY-MM-DD" (no time zone surprises).
// Working days are Monday to Friday, as in the original workbook.

const DAY = 86400000;

export function toDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

export function iso(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

export function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && toDate(v) !== null;
}

export function todayIso(now = new Date()) {
  return iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function addDays(d, n) {
  return iso(new Date(toDate(d).getTime() + n * DAY));
}

export function diffDays(a, b) {
  // a - b in days
  return Math.round((toDate(a) - toDate(b)) / DAY);
}

/** 1 = Monday ... 7 = Sunday */
export function weekday(d) {
  const w = toDate(d).getUTCDay();
  return w === 0 ? 7 : w;
}

export function monday(d) {
  return addDays(d, 1 - weekday(d));
}

/** D, or the Monday after when D is a weekend */
export function nextWorkday(d) {
  let x = d;
  while (weekday(x) > 5) x = addDays(x, 1);
  return x;
}

/** N working days after D (D itself moved to a working day first) */
export function addWorkdays(d, n) {
  let x = nextWorkday(d);
  while (n > 0) {
    x = addDays(x, 1);
    if (weekday(x) <= 5) n--;
  }
  return x;
}

/** Excel's WORKDAY(start, n): n working days after start (start itself not counted) */
export function workday(d, n) {
  let x = d;
  while (n > 0) {
    x = addDays(x, 1);
    if (weekday(x) <= 5) n--;
  }
  return x;
}

/** Working-day number of D on a board that starts on Monday w0 (0 = w0) */
export function workdayIndex(d, w0) {
  const x = nextWorkday(d);
  return Math.round(diffDays(monday(x), w0) / 7) * 5 + weekday(x) - 1;
}

/** Planning week 1.. (this week = 1; anything earlier counts as this week) */
export function planWeek(d, w0) {
  const k = Math.round(diffDays(monday(d), w0) / 7);
  return Math.max(k, 0) + 1;
}

export function monthStart(d) {
  return String(d).slice(0, 8) + '01';
}

export function addMonths(d, n) {
  const x = toDate(monthStart(d));
  return iso(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, 1)));
}

export function endOfMonth(d) {
  return addDays(addMonths(d, 1), -1);
}

/** The date of working-day number idx on a board that starts on Monday w0 (negative = before w0) */
export function workdayAt(w0, idx) {
  if (idx >= 0) return addWorkdays(w0, idx);
  let x = w0;
  let k = -idx;
  while (k > 0) {
    x = addDays(x, -1);
    if (weekday(x) <= 5) k--;
  }
  return x;
}
