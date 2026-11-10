'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

// Smallest thing that passes the JPEG magic-byte check.
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 0xff, 0xd9]).toString('base64')}`;
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%test\n').toString('base64')}`;

/** IST wall-clock -> epoch ms. */
const ist = (date, time) => Date.parse(`${date}T${time}:00+05:30`);

async function startServer(startAt, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-test-'));
  const clock = { now: startAt };
  const { profileRule, ...appOpts } = opts;
  const { app, db } = createApp({ dataDir, secret: 'test-secret', now: () => clock.now, ...appOpts });
  // Most tests use staff without phone/Aadhaar/PAN/bank details; the punch-in lock is tested on its own.
  if (!profileRule) db.prepare("UPDATE settings SET value = '0' WHERE key = 'profile_grace_days'").run();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    const jar = new Map(); // like a browser: each cookie (admin and staff login) kept separately
    return async function call(method, url, body) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const set of res.headers.getSetCookie()) {
        const [pair] = set.split(';');
        const i = pair.indexOf('=');
        const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
        if (v && !/Expires=Thu, 01 Jan 1970/i.test(set)) jar.set(k, v);
        else jar.delete(k);
      }
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers };
    };
  }

  return {
    base,
    dataDir,
    db,
    clock,
    client,
    async close() {
      await new Promise((r) => server.close(r));
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startServer, ist, JPEG, PDF };
