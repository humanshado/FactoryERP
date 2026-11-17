// Talking to the FactoryERP server. A 409 answer is a question ("Start anyway?"):
// the user is asked, and on yes the same call goes again with force: true.
import { askConfirm, toast } from './ui.jsx';

export class ApiError extends Error {}

export async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 409 && data?.confirm) {
    if (await askConfirm(data.error)) return api(method, url, { ...(body || {}), force: true });
    return null;
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
