'use strict';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_COOKIE_NAME = IS_PRODUCTION ? '__Host-zlotoweczka_session' : 'zlotoweczka_session';
const TELEGRAM_SESSION_COOKIE_NAME = IS_PRODUCTION ? '__Host-zlotoweczka_telegram' : 'zlotoweczka_telegram';
const GOOGLE_LINK_COOKIE_NAME = IS_PRODUCTION ? '__Host-zlotoweczka_google_link' : 'zlotoweczka_google_link';
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_COOKIE_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000;
const TELEGRAM_SESSION_MAX_AGE_MS = Number(process.env.TELEGRAM_SESSION_COOKIE_MAX_AGE_MS) || 12 * 60 * 60 * 1000;
const GOOGLE_LINK_MAX_AGE_MS = 10 * 60 * 1000;

function cookieOptions(maxAge) {
  const options = {
    httpOnly: true,
    secure: IS_PRODUCTION,
    // app.zlotoweczka.com.pl -> api.zlotoweczka.com.pl is same-site, so
    // production can use the strongest practical SameSite mode without breaking
    // Google popup callbacks or Telegram WebView API calls. Dev stays Lax for
    // localhost / split-origin tooling.
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',
    path: '/',
  };
  if (maxAge !== undefined) options.maxAge = maxAge;
  return options;
}

function parseCookieHeader(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(raw); }
    catch { out[key] = raw; }
  }
  return out;
}

function readCookie(req, name) {
  return parseCookieHeader(req?.headers?.cookie)[name] || '';
}

function readSessionCookie(req) {
  return readCookie(req, SESSION_COOKIE_NAME);
}

function readTelegramSessionCookie(req) {
  return readCookie(req, TELEGRAM_SESSION_COOKIE_NAME);
}

function readGoogleLinkCookie(req) {
  return readCookie(req, GOOGLE_LINK_COOKIE_NAME);
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE_NAME, String(token), cookieOptions(SESSION_MAX_AGE_MS));
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions());
}

function setTelegramSessionCookie(res, token) {
  res.cookie(TELEGRAM_SESSION_COOKIE_NAME, String(token), cookieOptions(TELEGRAM_SESSION_MAX_AGE_MS));
}

function clearTelegramSessionCookie(res) {
  res.clearCookie(TELEGRAM_SESSION_COOKIE_NAME, cookieOptions());
}

function setGoogleLinkCookie(res, secret) {
  res.cookie(GOOGLE_LINK_COOKIE_NAME, String(secret), cookieOptions(GOOGLE_LINK_MAX_AGE_MS));
}

function clearGoogleLinkCookie(res) {
  res.clearCookie(GOOGLE_LINK_COOKIE_NAME, cookieOptions());
}

module.exports = {
  SESSION_COOKIE_NAME,
  TELEGRAM_SESSION_COOKIE_NAME,
  GOOGLE_LINK_COOKIE_NAME,
  readSessionCookie,
  readTelegramSessionCookie,
  readGoogleLinkCookie,
  setSessionCookie,
  clearSessionCookie,
  setTelegramSessionCookie,
  clearTelegramSessionCookie,
  setGoogleLinkCookie,
  clearGoogleLinkCookie,
};
