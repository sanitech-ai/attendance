'use strict';
const { bad } = require('./util');

const GOOGLE_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|(www\.)?google\.[a-z.]+|maps\.google\.[a-z.]+)$/i;

function valid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/**
 * Pulls coordinates out of a Google Maps URL or plain "lat, lng" text.
 * Prefers the dropped-pin/place coordinates (!3d..!4d..) over the map view centre (@lat,lng).
 */
function parseCoords(text) {
  const s = decodeURIComponent(String(text || '').trim());
  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|query|ll|destination|center)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /\/search\/(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)/,
    /\/place\/(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (valid(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

/** Coordinates embedded in a Google Maps HTML page (static map centre/marker or @lat,lng URLs). */
function coordsFromPage(html) {
  const patterns = [
    // The place's own marker first; the map view centre can be somewhere else entirely.
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /[?&;]markers=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/,
    /[?&;]center=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/,
    /\/@(-?\d+\.\d+),(-?\d+\.\d+)/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && valid(Number(m[1]), Number(m[2]))) return { lat: Number(m[1]), lng: Number(m[2]) };
  }
  return null;
}

/** Resolves short links (maps.app.goo.gl/...) by following redirects, only ever to Google hosts. */
async function resolveMapsLink(input, fetchImpl = fetch) {
  const direct = parseCoords(input);
  if (direct) return direct;
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw bad('Paste a Google Maps link or coordinates like 17.4123, 78.4482');
  }
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== 'https:' || !GOOGLE_HOSTS.test(url.hostname)) throw bad('Only Google Maps links are supported');
    const found = parseCoords(url.href);
    if (found) return found;
    const res = await fetchImpl(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      // Google serves the full page (with coordinates) to browsers.
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 'Accept-Language': 'en-IN,en' },
    });
    const next = res.headers.get('location');
    if (!next) {
      const fromBody = coordsFromPage((await res.text()).slice(0, 2_000_000));
      if (fromBody) return fromBody;
      break;
    }
    url = new URL(next, url);
  }
  throw bad('Could not find a location in that link. In Google Maps, long-press the spot to drop a pin, then Share → Copy link.');
}

/** Town / district / state for a point, from OpenStreetMap (free; max ~1 request per second). */
async function placeName(lat, lng, fetchImpl = fetch) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${lat}&lon=${lng}`;
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'Sanitech-Attendance/1.0 (https://app.sanitech.in)', 'Accept-Language': 'en-IN,en' },
  });
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  const a = (await res.json()).address || {};
  const local = a.suburb || a.neighbourhood || a.village || a.town || a.city_district || a.city || a.hamlet || '';
  const district = a.state_district || a.county || (local !== a.city ? a.city : '') || '';
  return [...new Set([local, district, a.state].filter(Boolean))].join(', ');
}

/** Street-level address for a point (building / shop name, road, area, city), from OpenStreetMap. */
async function addressAt(lat, lng, fetchImpl = fetch) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`;
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(6000),
    headers: { 'User-Agent': 'Sanitech-Attendance/1.0 (https://app.sanitech.in)', 'Accept-Language': 'en-IN,en' },
  });
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  const j = await res.json();
  const a = j.address || {};
  const parts = [
    j.name || a.amenity || a.office || a.shop || a.building || '',
    [a.house_number, a.road].filter(Boolean).join(' '),
    a.suburb || a.neighbourhood || a.village || a.hamlet || '',
    a.city || a.town || a.state_district || a.county || '',
  ];
  return [...new Set(parts.filter(Boolean))].join(', ').slice(0, 200);
}

module.exports = { parseCoords, coordsFromPage, resolveMapsLink, placeName, addressAt };
