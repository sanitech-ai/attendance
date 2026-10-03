'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDb } = require('./db');
const { HttpError, randomToken, sha256, encrypt, decrypt, verifySecret } = require('./util');

const SESSION_DAYS = { admin: 7, employee: 30 };
const COOKIE = { admin: 'asid', employee: 'esid' };
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

function loadKey(dataDir, secret) {
  if (secret) {
    return crypto.createHash('sha256').update(secret).digest();
  }
  const keyFile = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn(`APP_SECRET is not set; generated an encryption key at ${keyFile}. Back it up — without it, stored selfies and documents cannot be read.`);
  }
  return crypto.createHash('sha256').update(fs.readFileSync(keyFile, 'utf8').trim()).digest();
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createApp({ dataDir, secret, secureCookies = false, now = () => Date.now() } = {}) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = openDb(path.join(dataDir, 'attendance.db'));
  const key = loadKey(dataDir, secret);
  const filesDir = path.join(dataDir, 'files');

  const ctx = {
    db,
    now,
    saveFile(buf) {
      const name = `${crypto.randomUUID()}.bin`;
      fs.writeFileSync(path.join(filesDir, name), encrypt(buf, key));
      return name;
    },
    readFile(name) {
      return decrypt(fs.readFileSync(path.join(filesDir, path.basename(name))), key);
    },
    deleteFile(name) {
      fs.rmSync(path.join(filesDir, path.basename(name)), { force: true });
    },
    audit(req, action, detail = '') {
      const actor = req.admin ? ['admin', req.admin.id] : req.employee ? ['employee', req.employee.id] : ['system', null];
      db.prepare('INSERT INTO audit_log (at, actor_kind, actor_id, action, detail) VALUES (?, ?, ?, ?, ?)').run(
        now(), actor[0], actor[1], action, typeof detail === 'string' ? detail : JSON.stringify(detail),
      );
    },
    startSession(res, kind, userId) {
      const token = randomToken();
      const ttl = SESSION_DAYS[kind] * 86400000;
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
      db.prepare('INSERT INTO sessions (token_hash, kind, user_id, expires_at) VALUES (?, ?, ?, ?)').run(
        sha256(token), kind, userId, now() + ttl,
      );
      res.cookie(COOKIE[kind], token, {
        httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: ttl, path: '/',
      });
    },
    endSession(req, res, kind) {
      const token = parseCookies(req.headers.cookie)[COOKIE[kind]];
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
      res.clearCookie(COOKIE[kind], { path: '/' });
    },
    endAllSessions(kind, userId) {
      db.prepare('DELETE FROM sessions WHERE kind = ? AND user_id = ?').run(kind, userId);
    },
    /** Checks a password/PIN with lockout after repeated failures. */
    checkLogin(table, row, secretValue, hashField) {
      if (!row) throw new HttpError(401, 'Invalid credentials');
      if (row.locked_until && row.locked_until > now()) {
        const mins = Math.ceil((row.locked_until - now()) / 60000);
        throw new HttpError(429, `Too many wrong attempts. Try again in ${mins} minute(s).`);
      }
      if (!verifySecret(secretValue, row[hashField])) {
        const failed = row.failed_logins + 1;
        const lock = failed >= MAX_FAILED_LOGINS ? now() + LOCK_MS : null;
        db.prepare(`UPDATE ${table} SET failed_logins = ?, locked_until = ? WHERE id = ?`).run(lock ? 0 : failed, lock, row.id);
        throw new HttpError(401, 'Invalid credentials');
      }
      db.prepare(`UPDATE ${table} SET failed_logins = 0, locked_until = NULL WHERE id = ?`).run(row.id);
    },
  };

  function requireSession(kind) {
    return (req, res, next) => {
      const token = parseCookies(req.headers.cookie)[COOKIE[kind]];
      const sess = token
        && db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ?').get(sha256(token), kind, now());
      if (!sess) throw new HttpError(401, 'Please log in');
      if (kind === 'admin') {
        const admin = db.prepare('SELECT id, username, name FROM admins WHERE id = ?').get(sess.user_id);
        if (!admin) throw new HttpError(401, 'Please log in');
        req.admin = admin;
      } else {
        const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(sess.user_id);
        if (!emp) throw new HttpError(401, 'Please log in');
        req.employee = emp;
      }
      next();
    };
  }
  ctx.requireSession = requireSession;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN', // the admin's staff preview frames the staff app
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
    });
    next();
  });
  app.use('/api', express.json({ limit: '12mb' }));
  // JSON-only API + SameSite=strict cookies: reject other content types to block form-based CSRF.
  app.use('/api', (req, res, next) => {
    // req.is() is null when there is no body and false when the body has another type.
    const emptyBody = req.headers['content-length'] === '0';
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && !emptyBody && req.is('application/json') === false) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/api/employee', require('./routes/employee')(ctx));
  app.use('/api/admin', require('./routes/admin')(ctx));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, {
    extensions: ['html'],
    setHeaders(res) {
      res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    },
  }));

  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (String(err.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'Already exists' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return { app, db, ctx };
}

module.exports = { createApp };
