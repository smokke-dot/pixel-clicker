'use strict';
/*
 * Pixel Clicker — backend (Telegram Mini App)
 * Чистый Node.js, без зависимостей. Требуется Node 18+ (глобальный fetch).
 *
 * Запуск:  BOT_TOKEN=123:ABC node server.js
 *   (или  $env:BOT_TOKEN="123:ABC"; node server.js  — в PowerShell)
 *
 * Возможности:
 *   - раздаёт index.html (та же папка) и API на том же origin;
 *   - авторизация по Telegram WebApp initData (HMAC-SHA256);
 *   - рейтинг (топ) по престижу и кликам;
 *   - продажа скинов за Telegram Stars (XTR) через createInvoiceLink;
 *   - long-poll бота: подтверждение pre_checkout_query и фиксация successful_payment.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_FILE = path.join(__dirname, 'data.json');
const TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

/* Платные скины — серверный источник цен (Stars). */
const PAID_SKINS = {
  gold:    { price: 25,  name: 'Золотой',        desc: 'Все доходы x1.5' },
  neon:    { price: 50,  name: 'Неон',           desc: 'Автодоход x2.5' },
  rainbow: { price: 100, name: 'Радужная звезда', desc: 'Клик и авто x2' },
  dragon:  { price: 250, name: 'Дракон',         desc: 'Все доходы x3' }
};

/* ---------------- Хранилище (JSON-файл) ---------------- */
let db;
function loadDb() {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { db = {}; }
  if (!db || typeof db !== 'object') db = {};
  db.users = db.users || {};
  db.purchases = db.purchases || {};
  for (const k in db.users) {
    const u = db.users[k];
    u.skins = Array.isArray(u.skins) ? u.skins : [];
    u.prestige = (typeof u.prestige === 'number') ? u.prestige : 0;
    u.clicks = (typeof u.clicks === 'number') ? u.clicks : 0;
    u.coins = (typeof u.coins === 'number') ? u.coins : 0;
    u.cps = (typeof u.cps === 'number') ? u.cps : 0;
    u.prestiges = (typeof u.prestiges === 'number') ? u.prestiges : 0;
  }
}
function saveDb() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
}
loadDb();

function ensureUser(id, name, username) {
  id = String(id);
  if (!db.users[id]) {
    db.users[id] = {
      id, name: name || ('Игрок ' + id), username: username || '',
      prestige: 0, clicks: 0, coins: 0, cps: 0, prestiges: 0, skins: [], updatedAt: Date.now()
    };
  }
  return db.users[id];
}

/* ---------------- Проверка initData ---------------- */
function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string' || !BOT_TOKEN) return null;
  const parts = initData.split('&');
  let hash = '';
  const filtered = [];
  for (const p of parts) {
    if (p.startsWith('hash=')) hash = p.slice(5);
    else if (p) filtered.push(p);
  }
  if (!hash) return null;
  const dataCheckString = filtered.sort().join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const usp = new URLSearchParams(initData);
  let user;
  try { user = JSON.parse(usp.get('user') || '{}'); } catch (e) { return null; }
  if (!user || !user.id) return null;
  const authDate = parseInt(usp.get('auth_date') || '0', 10);
  if (authDate && (Date.now() / 1000 - authDate) > 86400) return null; // старше суток
  return user;
}

/* ---------------- Рейтинг ---------------- */
const METRICS = {
  coins:     { key: 'coins' },
  cps:       { key: 'cps' },
  shards:    { key: 'prestige' },
  prestiges: { key: 'prestiges' }
};
function sortedUsers(metric) {
  const m = METRICS[metric] || METRICS.shards;
  return Object.values(db.users).sort((a, b) => (b[m.key] - a[m.key]) || (b.prestige - a.prestige));
}
function topUsers(metric) {
  return sortedUsers(metric).slice(0, 100).map((u, i) => ({
    rank: i + 1, id: u.id, name: u.name, username: u.username,
    coins: Math.floor(u.coins || 0), cps: Math.floor(u.cps || 0),
    prestige: u.prestige || 0, prestiges: u.prestiges || 0, clicks: u.clicks || 0
  }));
}
function computeRank(id, metric) {
  id = String(id);
  const idx = sortedUsers(metric).findIndex(u => String(u.id) === id);
  return idx >= 0 ? idx + 1 : 0;
}

/* ---------------- Telegram API ---------------- */
async function createInvoice(skinId, userId, token) {
  const skin = PAID_SKINS[skinId];
  if (!skin) throw new Error('unknown skin');
  const body = {
    title: 'Скин «' + skin.name + '»',
    description: skin.desc + ' — Pixel Clicker',
    payload: 'skin:' + skinId + ':' + userId + ':' + token,
    currency: 'XTR',
    prices: [{ label: skin.name, amount: skin.price }]
  };
  const r = await fetch(TG_API + '/createInvoiceLink', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'telegram api error');
  return j.result;
}

/* ---------------- Long-poll бота ---------------- */
let updateOffset = 0;
function handleUpdate(u) {
  if (u.pre_checkout_query) {
    const q = u.pre_checkout_query;
    fetch(TG_API + '/answerPreCheckoutQuery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: q.id, ok: true })
    }).catch(() => {});
    return;
  }
  const m = u.message;
  if (m && m.successful_payment) {
    completePurchase(m.successful_payment.invoice_payload);
  }
}
function completePurchase(payload) {
  const m = String(payload || '').match(/^skin:([^:]+):(\d+):([A-Za-z0-9_-]+)$/);
  if (!m) return;
  const skinId = m[1], uid = m[2], token = m[3];
  const p = db.purchases[token];
  if (!p || p.paid) return;
  p.paid = true;
  const user = ensureUser(uid);
  if (!user.skins.includes(skinId)) user.skins.push(skinId);
  user.updatedAt = Date.now();
  saveDb();
}
async function pollLoop() {
  if (!BOT_TOKEN) { setTimeout(pollLoop, 5000); return; }
  try {
    const r = await fetch(TG_API + '/getUpdates?timeout=25&offset=' + updateOffset);
    const j = await r.json();
    if (j.ok && Array.isArray(j.result)) {
      for (const u of j.result) { updateOffset = u.update_id + 1; handleUpdate(u); }
    }
  } catch (e) {}
  setTimeout(pollLoop, 0);
}

/* ---------------- HTTP ---------------- */
function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}
function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = decodeURIComponent(p.split('?')[0]);
  const file = path.normalize(path.join(__dirname, p));
  if (!file.startsWith(__dirname)) { send(res, 403, { ok: false, error: 'forbidden' }); return; }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, { ok: false, error: 'not found' }); return; }
    const ext = path.extname(file).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.webmanifest': 'application/manifest+json'
    };
    // HTML не кэшируем вообще, остальное — перепроверять на сервере
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': (ext === '.html') ? 'no-store' : 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

  if (p === '/api/health') { send(res, 200, { ok: true, bot: !!BOT_TOKEN }); return; }

  if (p === '/api/profile' && req.method === 'POST') {
    const body = await readBody(req);
    const user = verifyInitData(body.initData);
    if (!user) { send(res, 401, { ok: false, error: 'invalid initData' }); return; }
    const u = ensureUser(user.id, user.first_name, user.username);
    send(res, 200, { ok: true, profile: { id: u.id, name: u.name, username: u.username, prestige: u.prestige, clicks: u.clicks, coins: u.coins, cps: u.cps, prestiges: u.prestiges, skins: u.skins } });
    return;
  }

  if (p === '/api/score' && req.method === 'POST') {
    const body = await readBody(req);
    const user = verifyInitData(body.initData);
    if (!user) { send(res, 401, { ok: false, error: 'invalid initData' }); return; }
    const u = ensureUser(user.id, user.first_name, user.username);
    if (typeof body.prestige === 'number' && isFinite(body.prestige) && body.prestige > u.prestige) u.prestige = Math.floor(body.prestige);
    if (typeof body.clicks === 'number' && isFinite(body.clicks) && body.clicks > u.clicks) u.clicks = Math.floor(body.clicks);
    if (typeof body.prestiges === 'number' && isFinite(body.prestiges) && body.prestiges > u.prestiges) u.prestiges = Math.floor(body.prestiges);
    if (typeof body.coins === 'number' && isFinite(body.coins)) u.coins = Math.floor(body.coins);
    if (typeof body.cps === 'number' && isFinite(body.cps)) u.cps = Math.floor(body.cps);
    u.updatedAt = Date.now();
    saveDb();
    send(res, 200, { ok: true, ranks: {
      coins: computeRank(u.id, 'coins'),
      cps: computeRank(u.id, 'cps'),
      shards: computeRank(u.id, 'shards'),
      prestiges: computeRank(u.id, 'prestiges')
    } });
    return;
  }

  if (p === '/api/leaderboard') {
    const type = url.searchParams.get('type') || 'shards';
    send(res, 200, { ok: true, type, top: topUsers(type) });
    return;
  }

  if (p === '/api/skin/invoice' && req.method === 'POST') {
    const body = await readBody(req);
    const user = verifyInitData(body.initData);
    if (!user) { send(res, 401, { ok: false, error: 'invalid initData' }); return; }
    const skinId = body.skinId;
    if (!PAID_SKINS[skinId]) { send(res, 400, { ok: false, error: 'unknown skin' }); return; }
    const u = ensureUser(user.id, user.first_name, user.username);
    if (u.skins.includes(skinId)) { send(res, 200, { ok: false, error: 'already owned' }); return; }
    const token = crypto.randomBytes(12).toString('hex');
    db.purchases[token] = { token, userId: String(u.id), skinId, paid: false, createdAt: Date.now() };
    saveDb();
    try {
      const link = await createInvoice(skinId, u.id, token);
      send(res, 200, { ok: true, link, token });
    } catch (e) {
      delete db.purchases[token]; saveDb();
      send(res, 500, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  if (p === '/api/skin/status') {
    const token = url.searchParams.get('token') || '';
    const initData = url.searchParams.get('initData') || '';
    const user = verifyInitData(initData);
    const pur = db.purchases[token];
    const skins = user ? ensureUser(user.id, user.first_name, user.username).skins : [];
    send(res, 200, { ok: true, paid: !!(pur && pur.paid), skins });
    return;
  }

  serveStatic(res, p);
});

server.listen(PORT, () => {
  console.log('Pixel Clicker server: http://localhost:' + PORT);
  if (BOT_TOKEN) { console.log('Бот запущен, слушаю платежи...'); pollLoop(); }
  else { console.log('ВНИМАНИЕ: BOT_TOKEN не задан — топ и скины за звёзды отключены.'); }
});
