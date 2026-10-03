'use strict';
const path = require('node:path');
const { createApp } = require('./app');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const port = Number(process.env.PORT) || 3000;
const production = process.env.NODE_ENV === 'production';

if (production && !process.env.APP_SECRET) {
  console.error('APP_SECRET must be set in production (a long random string used to encrypt selfies and documents).');
  process.exit(1);
}

const { app } = createApp({ dataDir, secret: process.env.APP_SECRET, secureCookies: production });
app.listen(port, () => {
  console.log(`Attendance app running on http://localhost:${port}`);
  console.log(`  Staff app:  http://localhost:${port}/`);
  console.log(`  Admin:      http://localhost:${port}/admin`);
  console.log(`  Data dir:   ${dataDir}`);
});
