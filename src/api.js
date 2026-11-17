// Talking to the FactoryERP server.
//  - every request carries the X-FactoryERP header (the server refuses changes without it)
//  - 401: the session ended, so the app shows the sign-in screen
//  - 409 with confirm: a question ("Start anyway?"); on yes the same call goes again with force: true
//  - 409 with conflict: someone else changed the record; the screens reload
import { askConfirm, signalChange, toast } from './ui.jsx';

export class ApiError extends Error {}

let onUnauthorized = () => {};
export const setOnUnauthorized = (fn) => {
  onUnauthorized = fn;
};

export async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-FactoryERP': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401 && !url.startsWith('/auth/')) {
    onUnauthorized();
    throw new ApiError('Your session ended: please sign in again.');
  }
  if (res.status === 409 && data?.confirm) {
    if (await askConfirm(data.error)) return api(method, url, { ...(body || {}), force: true });
    return null;
  }
  if (res.status === 409 && data?.conflict) {
    signalChange();
    const e = new ApiError(data.error);
    e.conflict = true;
    throw e;
  }
  if (!res.ok) throw new ApiError(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

/** Run a call, show its message (or its error) as a toast. Returns the answer, or null on error. */
export async function run(method, url, body) {
  try {
    const out = await api(method, url, body);
    if (out?.message) toast(out.message, out.warning ? 'warn' : 'ok');
    return out;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

export const get = (url) => api('GET', url);
