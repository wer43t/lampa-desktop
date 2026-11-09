#!/usr/bin/env node
/**
 * Home sync server for Lampa (PC <-> TV <-> phone). Zero dependencies.
 *
 *   node sync-server/server.js [--port 8095] [--data <dir>]
 *
 * GET  /          the whole Lampa web build (src/) for TVs/phones: point the LAMPA Android
 *                  app (or a browser) at http://<pc>:8095/ and it runs the same version as
 *                  the PC, with the core the desktop app currently uses (incl. self-updates)
 * GET  /lampa.js  plugin bundle, for Lampa installs that keep loading another site
 * GET  /echo      health check
 * POST /sync      { since, timeline, fav, kv } -> merged changes newer than `since`
 *
 * Merge rules (last writer wins, per entry):
 *   timeline  file_view entries, by road.updated
 *   fav       bookmark/history membership "<where>:<id>", by t
 *   kv        "<namespace>:<key>" records (resume, audio choice), by u
 * Every accepted change gets a new sequence number; clients pull everything after
 * their cursor, so nothing is lost if a device was off for a while.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const PORT = parseInt(arg('port', process.env.LAMPA_SYNC_PORT || '8095'), 10);
const DATA_DIR = arg('data', process.env.LAMPA_SYNC_DATA ||
  path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'lampa-sync'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SRC_DIR = path.join(__dirname, '..', 'src');
const BUNDLE = ['desktop-resume.js', 'desktop-audio.js', 'lampa-sync.js'];
const MAX_BODY = 20 * 1024 * 1024;
const WHERE = new Set(['book', 'like', 'wath', 'history', 'look', 'viewed', 'scheduled', 'continued', 'thrown']);
const KV_NS = new Set(['resume', 'audio', 'settings']);

// Electron main-process files: nothing a browser needs, so never served.
const PRIVATE = new Set(['index.js', 'preload.js', 'players.js', 'store.js', 'menu.js', 'lampa-core.js']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
};

// The Lampa core the desktop app runs: a self-updated copy (src/lampa-core.js) or the bundled one.
const CORE_ROOT = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Lampa', 'lampa-core');
function coreFile(name) {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(CORE_ROOT, 'active.json'), 'utf-8'));
    if (/^[0-9]+(\.[0-9]+){1,3}$/.test(active.version)) {
      const file = path.join(CORE_ROOT, active.version, name);
      if (fs.existsSync(file)) return file;
    }
  } catch (error) {
    // no downloaded core
  }
  return null;
}

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  } catch (error) {
    return false;
  }
  if (rel === 'lampa.js' || PRIVATE.has(rel)) return false;

  let file = rel === 'app.js' ? coreFile('app.js') : rel === 'css/app.css' ? coreFile('app.css') : null;
  if (!file) {
    file = path.resolve(SRC_DIR, rel);
    if (file !== SRC_DIR && !file.startsWith(SRC_DIR + path.sep)) return false;
  }

  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return false;
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (error) {
    return false;
  }
  // revalidate code/pages every time so a TV picks up changes; media can be cached
  const cache = /\.(html|js|css|json)$/i.test(file) ? 'no-cache' : 'max-age=86400';
  res.writeHead(200, Object.assign({ 'content-type': type, 'cache-control': cache }, cors));
  res.end(data);
  return true;
}

let state = { seq: 0, timeline: {}, fav: {}, cards: {}, kv: {}, devices: {} };
try {
  state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')));
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('[sync] state unreadable, starting empty:', error.message);
}

let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }, 500);
};

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

const STARTED = Date.now();

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
}

function deviceName(ip, ua) {
  if (/Electron/i.test(ua) || ip === '127.0.0.1') return 'ПК (Lampa Desktop)';
  if (/Android TV|AFT|BRAVIA|SMART-TV|SmartTV|Tizen|Web0S|webOS/i.test(ua)) return 'Телевизор';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Телефон Android' : 'Android';
  if (/iPhone|iPad/i.test(ua)) return 'iOS';
  return 'Браузер';
}

function touchDevice(req, body, before) {
  if (!state.devices || typeof state.devices !== 'object') state.devices = {};
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const key = `${ip}|${ua}`;
  const isNew = !state.devices[key];
  const d = state.devices[key] || { ip, ua, name: deviceName(ip, ua), first: Date.now(), syncs: 0, pushed: 0 };
  d.last = Date.now();
  d.syncs++;
  d.cursor = num(body.since);
  const sent = Object.keys(body.timeline || {}).length + (Array.isArray(body.fav) ? body.fav.length : 0) + Object.keys(body.kv || {}).length;
  if (sent) d.lastPush = Date.now();
  d.pushed += state.seq - before;
  state.devices[key] = d;
  return isNew;
}

function stats() {
  const fav = {};
  for (const key of Object.keys(state.fav)) {
    const e = state.fav[key];
    if (e.on) fav[e.where] = (fav[e.where] || 0) + 1;
  }
  const kv = {};
  for (const key of Object.keys(state.kv)) {
    const ns = key.split(':')[0];
    kv[ns] = (kv[ns] || 0) + 1;
  }
  const recent = [];
  for (const key of Object.keys(state.fav)) {
    const e = state.fav[key];
    const card = state.cards[e.id];
    recent.push({ s: e.s, kind: 'fav', what: `${e.on ? '+' : '-'} ${e.where}`, title: card ? card.title || card.name || String(e.id) : String(e.id), t: e.t });
  }
  for (const hash of Object.keys(state.timeline)) {
    const e = state.timeline[hash];
    recent.push({ s: e.s, kind: 'timeline', what: `${Math.round(e.v.percent)}%`, title: `hash ${hash}`, t: e.v.updated });
  }
  for (const key of Object.keys(state.kv)) {
    const e = state.kv[key];
    recent.push({ s: e.s, kind: 'kv', what: key.split(':')[0], title: key.slice(key.indexOf(':') + 1), t: e.u > 1 ? e.u : 0 });
  }
  recent.sort((a, b) => b.s - a.s);
  let size = 0;
  try { size = fs.statSync(STATE_FILE).size; } catch (error) { size = 0; }
  const devices = Object.values(state.devices || {}).sort((a, b) => b.last - a.last);
  return {
    seq: state.seq, started: STARTED, now: Date.now(), dataFile: STATE_FILE, size,
    timeline: Object.keys(state.timeline).length, cards: Object.keys(state.cards).length,
    fav, kv, devices, recent: recent.slice(0, 30)
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(t, now) {
  if (!t) return '-';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / 86400)} дн назад`;
}

function statusPage() {
  const st = stats();
  const now = st.now;
  const date = (t) => (t ? new Date(t).toLocaleString('ru-RU') : '-');
  const online = (d) => now - d.last < 90000;
  const tiles = [
    ['Изменений (seq)', st.seq], ['Таймкодов', st.timeline], ['Карточек', st.cards],
    ['Устройств', st.devices.length], ['Файл данных', `${(st.size / 1024).toFixed(1)} КБ`], ['Сервер запущен', ago(st.started, now)]
  ].map(([k, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('');
  const kvRows = (obj) => Object.keys(obj).sort().map((k) => `<tr><td>${esc(k)}</td><td class="n">${obj[k]}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">пусто</td></tr>';
  const devRows = st.devices.map((d) => `<tr>
<td><span class="dot ${online(d) ? 'on' : ''}"></span>${esc(d.name)}<div class="muted small" title="${esc(d.ua)}">${esc(d.ua.slice(0, 80))}</div></td>
<td>${esc(d.ip)}</td><td title="${esc(date(d.last))}">${esc(ago(d.last, now))}</td>
<td title="${esc(date(d.lastPush))}">${esc(ago(d.lastPush, now))}</td>
<td class="n">${d.syncs}</td><td class="n">${d.pushed}</td><td class="n">${d.cursor} / ${st.seq}</td>
<td>${esc(date(d.first))}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">ещё никто не синхронизировался после обновления сервера</td></tr>';
  const recentRows = st.recent.map((r) => `<tr><td class="n">${r.s}</td><td>${esc(r.kind)}</td><td>${esc(r.what)}</td><td>${esc(r.title)}</td><td>${esc(r.t ? ago(r.t, now) : '-')}</td></tr>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Lampa Sync</title><style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c1e21;--muted:#6b7280;--line:#e5e7eb;--acc:#2563eb;--ok:#16a34a}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1a1d21;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2a2f35;--acc:#60a5fa;--ok:#22c55e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--muted)}.small{font-size:12px}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile .v{font-size:20px;font-weight:600}.tile .k{color:var(--muted);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow-x:auto}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}
tr:last-child td{border-bottom:0}.n{text-align:right;font-variant-numeric:tabular-nums}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:700px){.cols{grid-template-columns:1fr}}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--line);margin-right:8px}
.dot.on{background:var(--ok)}a{color:var(--acc)}</style></head><body><main>
<h1>Lampa Sync</h1><div class="muted small">${esc(st.dataFile)} · обновляется каждые 15 с · <a href="/status.json">JSON</a></div>
<div class="tiles">${tiles}</div>
<h2>Устройства</h2><div class="card"><table><tr><th>Устройство</th><th>IP</th><th>Последний опрос</th><th>Последняя отправка</th><th class="n">Опросов</th><th class="n">Принято изменений</th><th class="n">Курсор</th><th>Впервые</th></tr>${devRows}</table></div>
<div class="cols"><div><h2>Закладки и история</h2><div class="card"><table>${kvRows(st.fav)}</table></div></div>
<div><h2>Прочие данные</h2><div class="card"><table>${kvRows(st.kv)}</table></div></div></div>
<h2>Последние изменения</h2><div class="card"><table><tr><th class="n">#</th><th>Тип</th><th>Что</th><th>Объект</th><th>Когда</th></tr>${recentRows}</table></div>
</main></body></html>`;
}

function merge(body) {
  let changed = false;
  const bump = () => { changed = true; return ++state.seq; };

  const timeline = body.timeline && typeof body.timeline === 'object' ? body.timeline : {};
  for (const hash of Object.keys(timeline)) {
    const road = timeline[hash];
    if (!road || typeof road !== 'object' || !/^-?\d+$/.test(hash)) continue;
    const cur = state.timeline[hash];
    if (cur && num(cur.v.updated) >= num(road.updated)) continue;
    state.timeline[hash] = {
      v: {
        time: num(road.time), duration: num(road.duration), percent: num(road.percent),
        profile: num(road.profile), updated: num(road.updated)
      },
      s: bump()
    };
  }

  for (const f of Array.isArray(body.fav) ? body.fav : []) {
    if (!f || !WHERE.has(f.where) || f.id == null) continue;
    const key = `${f.where}:${f.id}`;
    const cur = state.fav[key];
    if (cur && num(cur.t) >= num(f.t)) continue;
    state.fav[key] = { where: f.where, id: f.id, on: !!f.on, t: num(f.t), s: bump() };
    if (f.on && f.card && typeof f.card === 'object') state.cards[f.id] = f.card;
  }

  const kv = body.kv && typeof body.kv === 'object' ? body.kv : {};
  for (const key of Object.keys(kv)) {
    const item = kv[key];
    if (!item || !KV_NS.has(key.split(':')[0])) continue;
    const cur = state.kv[key];
    if (cur && num(cur.u) >= num(item.u)) continue;
    state.kv[key] = { v: item.v, u: num(item.u), s: bump() };
  }

  return changed;
}

function changesSince(since) {
  const out = { cursor: state.seq, timeline: {}, fav: [], kv: {} };
  for (const hash of Object.keys(state.timeline)) {
    const e = state.timeline[hash];
    if (e.s > since) out.timeline[hash] = e.v;
  }
  for (const key of Object.keys(state.fav)) {
    const e = state.fav[key];
    if (e.s > since) out.fav.push({ where: e.where, id: e.id, on: e.on, t: e.t, card: e.on ? state.cards[e.id] || null : null });
  }
  for (const key of Object.keys(state.kv)) {
    const e = state.kv[key];
    if (e.s > since) out.kv[key] = { v: e.v, u: e.u };
  }
  return out;
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS'
};

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, Object.assign({ 'content-type': type, 'cache-control': 'no-store' }, cors));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (req.method === 'GET' && url.pathname === '/echo') {
    return send(res, 200, { ok: true, seq: state.seq });
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    return send(res, 200, statusPage(), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/status.json') {
    return send(res, 200, stats());
  }

  if (req.method === 'GET' && url.pathname === '/lampa.js') {
    try {
      const code = BUNDLE.map((f) => `/* ${f} */\n` + fs.readFileSync(path.join(SRC_DIR, f), 'utf-8')).join('\n;\n');
      return send(res, 200, code, 'application/javascript; charset=utf-8');
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/sync') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { send(res, 413, { error: 'too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      } catch (error) {
        return send(res, 400, { error: 'bad json' });
      }
      const before = state.seq;
      const changed = merge(body);
      if (touchDevice(req, body, before) || changed) save();
      send(res, 200, changesSince(num(body.since)));
    });
    return;
  }

  if (req.method === 'GET' && serveStatic(url.pathname, res)) return;

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`[sync] listening on :${PORT}, data ${STATE_FILE}`);
  lan.forEach((ip) => console.log(`[sync] Lampa for TV/phone: http://${ip}:${PORT}/  (plugin only: /lampa.js)`));
});
