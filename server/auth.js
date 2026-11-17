// Sign-in: passwords hashed with scrypt, sessions in the database (only a hash of the token is kept),
// an HttpOnly cookie, a header every changing request must carry (so other sites cannot post here),
// and a pause after repeated wrong passwords.
import crypto from 'node:crypto';
import { ActionError, ctx } from './db.js';
import { ROLES, can } from '../shared/permissions.js';

export const COOKIE = 'ferp_session';
export const CSRF_HEADER = 'x-factoryerp';
const SESSION_HOURS = Number(process.env.FACTORYERP_SESSION_HOURS) || 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

// ---------------------------------------------------------------- passwords
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [algo, N, salt, hash] = String(stored || '').split('$');
    if (algo !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: 8, p: 1 });
    return crypto.timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

const DUMMY = hashPassword('not a real password');

export function checkPassword(pw) {
  if (String(pw || '').length < 10) throw new ActionError('Use a password of at least 10 characters.');
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwertyuiop)/i.test(pw)) throw new ActionError('That password is too easy to guess.');
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function cleanUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

export function checkRoles(roles) {
  if (!Array.isArray(roles) || !roles.length) throw new ActionError('Give the user at least one role.');
  for (const r of roles) if (!ROLES[r]) throw new ActionError(`Unknown role: ${r}`);
}

// ---------------------------------------------------------------- throttle
function throttleKey(req, username) {
  return `${req.ip}|${String(username || '').toLowerCase()}`;
}
function assertNotLocked(fails, key) {
  const f = fails.get(key);
  if (f && f.until && f.until > Date.now()) {
    const min = Math.ceil((f.until - Date.now()) / 60000);
    throw new ActionError(`Too many wrong passwords. Try again in ${min} minute${min === 1 ? '' : 's'}.`, 429);
  }
}
function noteFail(fails, key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAILS) {
    f.until = Date.now() + LOCK_MINUTES * 60000;
    f.n = 0;
  }
  fails.set(key, f);
}

// ---------------------------------------------------------------- cookies
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, token, maxAgeSec) {
  const secure = req.secure || process.env.FACTORYERP_SECURE_COOKIE === '1';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}

export async function startSession(store, req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  await store.createSession({ tokenHash: sha(token), userId: user.id, expiresAt, ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) });
  setCookie(req, res, token, SESSION_HOURS * 3600);
}

// ---------------------------------------------------------------- middleware
/** Who is asking (req.user), in the request context so every write is stamped and audited with them */
export function authenticate(store) {
  let lastPurge = 0;
  return async (req, res, next) => {
    try {
      if (Date.now() - lastPurge > 3600000) {
        lastPurge = Date.now();
        await store.purgeSessions();
      }
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) {
        const s = await store.session(sha(token));
        if (s && s.expiresAt > new Date().toISOString()) {
          const u = await store.get('users', s.userId);
          if (u && u.active) {
            req.user = cleanUser(u);
            req.sessionHash = s.tokenHash;
            // sliding: a session used in its second half gets a fresh lifetime
            if (Date.parse(s.expiresAt) - Date.now() < (SESSION_HOURS * 3600000) / 2) {
              await store.extendSession(s.tokenHash, new Date(Date.now() + SESSION_HOURS * 3600000).toISOString());
              setCookie(req, res, token, SESSION_HOURS * 3600);
            }
          }
        }
      }
      ctx.run({ user: req.user || null, ip: req.ip }, next);
    } catch (e) {
      next(e);
    }
  };
}

/** Changing requests must carry the FactoryERP header: a page on another site cannot add it */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers[CSRF_HEADER] !== '1') return res.status(403).json({ error: 'Missing the FactoryERP request header.' });
  return next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.', auth: true });
  return next();
}

export function assertCan(req, perm) {
  if (!can(req.user, perm)) {
    throw new ActionError(`Your role does not allow this (needs: ${perm}). Ask an administrator.`, 403);
  }
}

// ---------------------------------------------------------------- routes
export function authRoutes(app, store, wrap) {
  const fails = new Map(); // ip|user -> { n, until }: wrong passwords
  app.get('/api/auth/me', wrap(async (req) => ({
    user: req.user || null,
    setupNeeded: (await store.countUsers()) === 0,
    roles: ROLES,
  })));

  /** The first administrator, once, on a new installation */
  app.post('/api/auth/setup', wrap(async (req, res) => {
    const { username, name, password } = req.body || {};
    if (!String(username || '').trim()) throw new ActionError('Choose a user name.');
    checkPassword(password);
    const user = await store.tx(async () => {
      if ((await store.countUsers()) > 0) throw new ActionError('FactoryERP is set up already: sign in.', 409);
      return store.insert('users', { username: String(username).trim(), name: String(name || username).trim(), roles: ['admin'], passwordHash: hashPassword(password), active: true });
    });
    await ctx.run({ user: cleanUser(user) }, () => store.audit({ action: 'setup', table: 'users', recordId: user.id, summary: `${user.username} set up FactoryERP` }));
    await startSession(store, req, res, user);
    return { user: cleanUser(user) };
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    const key = throttleKey(req, username);
    assertNotLocked(fails, key);
    const u = await store.userByName(username);
    const ok = verifyPassword(password, u ? u.passwordHash : DUMMY) && u && u.active;
    if (!ok) {
      noteFail(fails, key);
      await store.audit({ action: 'login-failed', table: 'users', recordId: u?.id ?? null, summary: `Wrong sign-in for "${String(username || '').slice(0, 60)}" from ${req.ip}` });
      throw new ActionError('Wrong user name or password.', 401);
    }
    fails.delete(key);
    await ctx.run({ user: cleanUser(u) }, async () => {
      await store.update('users', u.id, { lastLogin: new Date().toISOString() }, { audit: false });
      await store.audit({ action: 'login', table: 'users', recordId: u.id, summary: `${u.username} signed in from ${req.ip}` });
    });
    await startSession(store, req, res, u);
    return { user: cleanUser(await store.get('users', u.id)) };
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    if (req.sessionHash) await store.deleteSessions('tokenHash', req.sessionHash);
    setCookie(req, res, '', 0);
    return { message: 'Signed out' };
  }));

  app.post('/api/auth/password', requireUser, wrap(async (req, res) => {
    const { current, next: pw } = req.body || {};
    const u = await store.get('users', req.user.id);
    if (!verifyPassword(current, u.passwordHash)) throw new ActionError('Your current password is not right.');
    checkPassword(pw);
    await store.update('users', u.id, { passwordHash: hashPassword(pw) });
    await store.deleteSessions('userId', u.id); // sign out everywhere else
    await startSession(store, req, res, u);
    return { message: 'Password changed. Other devices were signed out.' };
  }));

  // ------------------------------------------------------------ users (administrators)
  app.get('/api/users', requireUser, wrap(async (req) => {
    assertCan(req, 'users.manage');
    return (await store.all('users')).map(cleanUser);
  }));

  app.post('/api/users', requireUser, wrap(async (req) => {
    assertCan(req, 'users.manage');
    const { username, name, roles, password } = req.body || {};
    if (!String(username || '').trim()) throw new ActionError('Choose a user name.');
    if (await store.userByName(username)) throw new ActionError(`The user name "${username}" is taken.`);
    checkRoles(roles);
    checkPassword(password);
    const u = await store.insert('users', { username: String(username).trim(), name: String(name || username).trim(), roles, passwordHash: hashPassword(password), active: true });
    return { record: cleanUser(u), message: `${u.username} added` };
  }));

  app.put('/api/users/:id', requireUser, wrap(async (req) => {
    assertCan(req, 'users.manage');
    const id = Number(req.params.id);
    const u = await store.get('users', id);
    if (!u) throw new ActionError('That user no longer exists.', 404);
    const { name, roles, active, password } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = String(name).trim() || u.username;
    if (roles !== undefined) {
      checkRoles(roles);
      patch.roles = roles;
    }
    if (active !== undefined) patch.active = !!active;
    if (password) {
      checkPassword(password);
      patch.passwordHash = hashPassword(password);
    }
    return store.tx(async () => {
      if (id === req.user.id && (patch.active === false || (patch.roles && !patch.roles.includes('admin')))) {
        throw new ActionError('You cannot remove your own administrator access or switch yourself off.');
      }
      await store.update('users', id, patch, { rev: req.body.rev });
      const admins = (await store.all('users')).filter((x) => x.active && (x.roles || []).includes('admin'));
      if (!admins.length) throw new ActionError('FactoryERP needs at least one active administrator.');
      if (patch.active === false || patch.passwordHash) await store.deleteSessions('userId', id);
      return { record: cleanUser(await store.get('users', id)), message: `${u.username} saved${patch.passwordHash ? ' (new password; signed out everywhere)' : ''}` };
    });
  }));
}
