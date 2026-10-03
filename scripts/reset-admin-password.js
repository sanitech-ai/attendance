'use strict';
// Usage: npm run reset-admin -- <username> <new-password>
const path = require('node:path');
const { openDb } = require('../server/db');
const { hashSecret } = require('../server/util');

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Usage: npm run reset-admin -- <username> <new-password (min 8 chars)>');
  process.exit(1);
}
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const db = openDb(path.join(dataDir, 'attendance.db'));
const result = db
  .prepare('UPDATE admins SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE username = ?')
  .run(hashSecret(password), username);
if (!result.changes) {
  console.error(`No admin named "${username}". Existing admins:`, db.prepare('SELECT username FROM admins').all().map((a) => a.username).join(', ') || '(none)');
  process.exit(1);
}
db.prepare("DELETE FROM sessions WHERE kind = 'admin'").run();
console.log(`Password updated for ${username}.`);
