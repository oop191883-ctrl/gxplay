'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch (e) {}

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'gxplay.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE, pw TEXT, bal REAL DEFAULT 0, code TEXT UNIQUE, ref_by TEXT, refs INTEGER DEFAULT 0, created INTEGER, last_login INTEGER, ip TEXT, blocked INTEGER DEFAULT 0, bets INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, verif TEXT DEFAULT '{}', note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS deposits(id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL, coin TEXT, network TEXT, tx_hash TEXT, status TEXT DEFAULT 'pending', created INTEGER, decided INTEGER, admin_note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS addrs(id INTEGER PRIMARY KEY, user_id INTEGER, coin TEXT, network TEXT, address TEXT, UNIQUE(user_id,coin,network));
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY, username TEXT UNIQUE, pw TEXT);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, detail TEXT);`);
const q = (s, ...a) => db.prepare(s).all(...a), one = (s, ...a) => db.prepare(s).get(...a), run = (s, ...a) => db.prepare(s).run(...a);
const getSet = k => (one('SELECT v FROM settings WHERE k=?', k) || {}).v;
const setSet = (k, v) => run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v);
const log = (actor, action, detail = '') => run('INSERT INTO logs(ts,actor,action,detail) VALUES(?,?,?,?)', Date.now(), actor, action, String(detail).slice(0, 500));
let SECRET = process.env.SECRET || getSet('secret'); if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); setSet('secret', SECRET); }

// ---------- helpers ----------
const hash = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const verify = (pw, h) => { try { const [s, k] = h.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(k, 'hex')); } catch (e) { return false; } };
const sign = (p, ttl) => { const b = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + ttl })).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const unsign = t => { try { const [b, s] = String(t).split('.'); const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null; const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null; } catch (e) { return null; } };
const r2 = n => Math.round(n * 100) / 100;
const hits = new Map();
const limited = (key, max, win) => { const n = Date.now(), a = (hits.get(key) || []).filter(t => n - t < win); a.push(n); hits.set(key, a); return a.length > max; };
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const genCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (;;) { let s = ''; for (let i = 0; i < 8; i++) s += c[crypto.randomInt(c.length)]; if (!one('SELECT 1 x FROM users WHERE code=?', s)) return s; } };
async function notify(text) { const t = process.env.TELEGRAM_BOT_TOKEN || getSet('tg_token'), c = process.env.TELEGRAM_CHAT_ID || getSet('tg_chat'); if (!t || !c) return; try { await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c, text }) }); } catch (e) {} }
const pubUser = u => ({ id: u.id, name: u.name, email: u.email, bal: r2(u.bal), code: u.code, refs: u.refs, refBy: u.ref_by || null, created: u.created, stats: { bets: u.bets, wins: u.wins }, verif: JSON.parse(u.verif || '{}') });

// first admin
if (!one('SELECT 1 x FROM admins')) {
  const u = process.env.ADMIN_USER || 'admin', p = process.env.ADMIN_PASS || crypto.randomBytes(6).toString('base64url');
  run('INSERT INTO admins(username,pw) VALUES(?,?)', u, hash(p));
  console.log(`\n=== ADMIN LOGIN CREATED ===\n user: ${u}\n pass: ${p}\n (login ke baad Settings me badal lein)\n===========================\n`);
}

// ---------- http plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.woff2': 'font/woff2' };
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }
const readBody = req => new Promise((ok, no) => { let b = '', n = 0; req.on('data', d => { n += d.length; if (n > 1e6) { no(new HttpErr(413, 'Too large')); req.destroy(); } else b += d; }); req.on('end', () => { if (!b) return ok({}); try { ok(JSON.parse(b)); } catch (e) { no(new HttpErr(400, 'Bad JSON')); } }); });
const send = (res, s, o, h = {}) => { const b = Buffer.from(JSON.stringify(o)); res.writeHead(s, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h }); res.end(b); };
const str = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const cookie = (req, n) => (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(c => c[0] === n)?.[1];
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---------- user API ----------
async function userApi(req, res, p, body) {
  const m = req.method, ip = ipOf(req);
  const auth = () => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const s = unsign(t); const u = s && s.u ? one('SELECT * FROM users WHERE id=?', s.u) : null; if (!u || u.blocked) throw new HttpErr(401, 'Please log in again'); return u; };
  if (p === '/signup' && m === 'POST') {
    if (limited('su' + ip, 10, 3600e3)) throw new HttpErr(429, 'Too many attempts. Try later.');
    const name = str(body.name, 16), email = str(body.email).toLowerCase(), pw = typeof body.password === 'string' ? body.password : '', ref = str(body.ref, 10).toUpperCase();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new HttpErr(400, 'Username must be 3–16 characters: letters, numbers or _.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpErr(400, 'Enter a valid email address.');
    if (pw.length < 8 || pw.length > 100 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpErr(400, 'Password needs 8+ characters with a letter and a number.');
    if (one('SELECT 1 x FROM users WHERE name=?', name)) throw new HttpErr(409, 'Username already taken.');
    if (one('SELECT 1 x FROM users WHERE email=?', email)) throw new HttpErr(409, 'Email already registered.');
    let refBy = null; if (ref) { const r = one('SELECT id,code FROM users WHERE code=?', ref); if (!r) throw new HttpErr(400, 'Referral code not found.'); refBy = r.code; run('UPDATE users SET refs=refs+1 WHERE id=?', r.id); }
    const id = run('INSERT INTO users(name,email,pw,code,ref_by,created,last_login,ip) VALUES(?,?,?,?,?,?,?,?)', name, email, hash(pw), genCode(), refBy, Date.now(), Date.now(), ip).lastInsertRowid;
    log('user:' + name, 'signup', email); notify(`🆕 New registration\nUser: ${name}\nEmail: ${email}\nIP: ${ip}${refBy ? '\nRef: ' + refBy : ''}`);
    return send(res, 200, { token: sign({ u: +id }, 30 * 864e5), user: pubUser(one('SELECT * FROM users WHERE id=?', id)) });
  }
  if (p === '/login' && m === 'POST') {
    if (limited('li' + ip, 20, 900e3)) throw new HttpErr(429, 'Too many attempts. Try in 15 minutes.');
    const id = str(body.id), u = one('SELECT * FROM users WHERE name=? OR email=?', id, id.toLowerCase());
    if (!u || !verify(String(body.password || ''), u.pw)) throw new HttpErr(401, 'Wrong username/email or password.');
    if (u.blocked) throw new HttpErr(403, 'This account is blocked. Contact support.');
    run('UPDATE users SET last_login=?, ip=? WHERE id=?', Date.now(), ip, u.id);
    return send(res, 200, { token: sign({ u: u.id }, 30 * 864e5), user: pubUser(u) });
  }
  if (p === '/config' && m === 'GET') {
    const d = {}; for (const r of q("SELECT k,v FROM settings WHERE k LIKE 'dep:%'")) d[r.k.slice(4)] = r.v;
    return send(res, 200, { depositAddresses: d });
  }
  const u = auth();
  if (p === '/me' && m === 'GET') return send(res, 200, { user: pubUser(u) });
  if (p === '/stats' && m === 'PUT') { const b = Math.max(0, Math.min(1e9, +body.bets | 0)), w = Math.max(0, Math.min(b, +body.wins | 0)); if (b >= u.bets) run('UPDATE users SET bets=?, wins=? WHERE id=?', b, w, u.id); return send(res, 200, {}); }
  if (p === '/verif' && m === 'PUT') { const v = JSON.stringify(body.verif || {}); if (v.length > 5000) throw new HttpErr(400, 'Too large'); run('UPDATE users SET verif=? WHERE id=?', v, u.id); log('user:' + u.name, 'verification', 'updated'); return send(res, 200, {}); }
  if (p === '/change-password' && m === 'POST') {
    const pw = String(body.password || ''); if (!verify(String(body.current || ''), u.pw)) throw new HttpErr(400, 'Current password is wrong.');
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpErr(400, 'New password needs 8+ characters with a letter and a number.');
    run('UPDATE users SET pw=? WHERE id=?', hash(pw), u.id); return send(res, 200, {});
  }
  if (p === '/wallet' && m === 'GET') return send(res, 200, { addresses: q('SELECT coin,network,address FROM addrs WHERE user_id=?', u.id), balance: r2(u.bal) });
  if (p === '/wallet/address' && m === 'PUT') {
    if (!verify(String(body.password || ''), u.pw)) throw new HttpErr(400, 'Account password is wrong.');
    const coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase(), a = str(body.address, 200);
    if (!/^[A-Z0-9]{2,12}$/.test(coin) || !/^[A-Z0-9]{2,12}$/.test(net)) throw new HttpErr(400, 'Enter a valid coin and network.');
    if (!/^[A-Za-z0-9:._-]{20,200}$/.test(a)) throw new HttpErr(400, 'Enter a valid wallet address.');
    run('INSERT INTO addrs(user_id,coin,network,address) VALUES(?,?,?,?) ON CONFLICT(user_id,coin,network) DO UPDATE SET address=excluded.address', u.id, coin, net, a);
    log('user:' + u.name, 'address', `${coin}/${net} ${a}`); return send(res, 200, {});
  }
  if (p === '/deposits' && m === 'POST') {
    if (limited('dp' + u.id, 10, 3600e3)) throw new HttpErr(429, 'Too many submissions. Try later.');
    const amt = +body.amount, tx = str(body.txHash, 200), coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase();
    if (!(amt >= 1 && amt <= 1e8)) throw new HttpErr(400, 'Enter a valid amount.');
    if (tx.length < 8) throw new HttpErr(400, 'Enter the transaction hash (TXID).');
    if (one("SELECT 1 x FROM deposits WHERE tx_hash=? AND status!='rejected'", tx)) throw new HttpErr(409, 'This transaction was already submitted.');
    run('INSERT INTO deposits(user_id,amount,coin,network,tx_hash,created) VALUES(?,?,?,?,?,?)', u.id, r2(amt), coin, net, tx, Date.now());
    log('user:' + u.name, 'deposit-request', `₹${amt} ${coin}/${net}`); notify(`💰 Deposit request\nUser: ${u.name}\nAmount: ₹${amt}\n${coin}/${net}\nTX: ${tx}`);
    return send(res, 200, { message: 'Submitted. Your balance will be added after verification.' });
  }
  throw new HttpErr(404, 'Not found');
}

// ---------- admin API ----------
async function adminApi(req, res, p, body, url) {
  const m = req.method, ip = ipOf(req);
  if (p === '/login' && m === 'POST') {
    if (limited('al' + ip, 8, 900e3)) throw new HttpErr(429, 'Too many attempts. Try in 15 minutes.');
    const a = one('SELECT * FROM admins WHERE username=?', str(body.username));
    if (!a || !verify(String(body.password || ''), a.pw)) { log('?', 'admin-login-failed', ip); throw new HttpErr(401, 'Wrong username or password.'); }
    log(a.username, 'admin-login', ip);
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': `gx_admin=${sign({ a: a.id }, 7 * 864e5)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
  }
  if (p === '/logout') return send(res, 200, {}, { 'Set-Cookie': 'gx_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  const s = unsign(cookie(req, 'gx_admin')), adm = s && one('SELECT * FROM admins WHERE id=?', s.a);
  if (!adm) throw new HttpErr(401, 'Login required');
  if (m !== 'GET' && !String(req.headers['content-type'] || '').includes('json')) throw new HttpErr(400, 'Bad request');
  const A = adm.username, num = v => { const n = +v; if (!Number.isFinite(n)) throw new HttpErr(400, 'Invalid number'); return n; };
  let mt;
  if (p === '/summary') {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    return send(res, 200, {
      users: one('SELECT COUNT(*) c FROM users').c, today: one('SELECT COUNT(*) c FROM users WHERE created>=?', d0.getTime()).c, blocked: one('SELECT COUNT(*) c FROM users WHERE blocked=1').c,
      totalBal: r2(one('SELECT COALESCE(SUM(bal),0) s FROM users').s), pending: one("SELECT COUNT(*) c FROM deposits WHERE status='pending'").c,
      approved: r2(one("SELECT COALESCE(SUM(amount),0) s FROM deposits WHERE status='approved'").s), lastUser: one('SELECT COALESCE(MAX(id),0) m FROM users').m, lastDep: one('SELECT COALESCE(MAX(id),0) m FROM deposits').m,
      recent: q('SELECT id,name,email,created FROM users ORDER BY id DESC LIMIT 5')
    });
  }
  if (p === '/users' && m === 'GET') {
    const s = '%' + str(url.searchParams.get('q')).replace(/[%_]/g, '') + '%';
    return send(res, 200, { users: q('SELECT id,name,email,bal,blocked,created,last_login,ip,refs,ref_by FROM users WHERE name LIKE ? OR email LIKE ? OR code LIKE ? ORDER BY id DESC LIMIT 500', s, s, s) });
  }
  if ((mt = p.match(/^\/users\/(\d+)$/))) {
    const id = +mt[1], u = one('SELECT * FROM users WHERE id=?', id); if (!u) throw new HttpErr(404, 'User not found');
    if (m === 'GET') return send(res, 200, { user: { ...u, pw: undefined, verif: JSON.parse(u.verif || '{}') }, addrs: q('SELECT coin,network,address FROM addrs WHERE user_id=?', id), deposits: q('SELECT * FROM deposits WHERE user_id=? ORDER BY id DESC', id), referred: q('SELECT name,created FROM users WHERE ref_by=?', u.code) });
    if (m === 'PATCH') {
      const name = str(body.name, 16), email = str(body.email).toLowerCase();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new HttpErr(400, 'Bad username'); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpErr(400, 'Bad email');
      if (one('SELECT 1 x FROM users WHERE (name=? OR email=?) AND id!=?', name, email, id)) throw new HttpErr(409, 'Username/email already used');
      const bal = r2(num(body.bal)); run('UPDATE users SET name=?, email=?, bal=?, blocked=?, note=? WHERE id=?', name, email, bal, body.blocked ? 1 : 0, str(body.note, 500), id);
      log(A, 'user-edit', `${u.name}: bal ${u.bal}→${bal}, blocked ${u.blocked}→${body.blocked ? 1 : 0}`); return send(res, 200, {});
    }
    if (m === 'DELETE') { run('DELETE FROM addrs WHERE user_id=?', id); run('DELETE FROM deposits WHERE user_id=?', id); run('DELETE FROM users WHERE id=?', id); log(A, 'user-delete', u.name); return send(res, 200, {}); }
  }
  if ((mt = p.match(/^\/users\/(\d+)\/balance$/)) && m === 'POST') {
    const u = one('SELECT * FROM users WHERE id=?', +mt[1]); if (!u) throw new HttpErr(404, 'User not found');
    const d = r2(num(body.delta)); if (u.bal + d < 0) throw new HttpErr(400, 'Balance cannot go below 0'); run('UPDATE users SET bal=bal+? WHERE id=?', d, u.id);
    log(A, 'balance', `${u.name} ${d >= 0 ? '+' : ''}${d} ${str(body.reason)}`); return send(res, 200, {});
  }
  if ((mt = p.match(/^\/users\/(\d+)\/password$/)) && m === 'POST') {
    const pw = String(body.password || ''); if (pw.length < 8) throw new HttpErr(400, 'Min 8 characters'); const u = one('SELECT name FROM users WHERE id=?', +mt[1]); if (!u) throw new HttpErr(404, 'Not found');
    run('UPDATE users SET pw=? WHERE id=?', hash(pw), +mt[1]); log(A, 'user-password-reset', u.name); return send(res, 200, {});
  }
  if ((mt = p.match(/^\/users\/(\d+)\/address$/)) && m === 'PUT') {
    const coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase(), a = str(body.address, 200); if (!coin || !net) throw new HttpErr(400, 'Coin/network required');
    if (!a) run('DELETE FROM addrs WHERE user_id=? AND coin=? AND network=?', +mt[1], coin, net);
    else run('INSERT INTO addrs(user_id,coin,network,address) VALUES(?,?,?,?) ON CONFLICT(user_id,coin,network) DO UPDATE SET address=excluded.address', +mt[1], coin, net, a);
    log(A, 'user-address', `uid ${mt[1]} ${coin}/${net} ${a}`); return send(res, 200, {});
  }
  if (p === '/deposits' && m === 'GET') {
    const st = str(url.searchParams.get('status')); return send(res, 200, { deposits: q(`SELECT d.*, u.name FROM deposits d LEFT JOIN users u ON u.id=d.user_id ${st ? 'WHERE d.status=?' : 'WHERE ?=?'} ORDER BY d.id DESC LIMIT 500`, st || 1, st || 1) });
  }
  if ((mt = p.match(/^\/deposits\/(\d+)\/(approve|reject)$/)) && m === 'POST') {
    const d = one('SELECT * FROM deposits WHERE id=?', +mt[1]); if (!d) throw new HttpErr(404, 'Not found'); if (d.status !== 'pending') throw new HttpErr(400, 'Already ' + d.status);
    const ok = mt[2] === 'approve', amt = ok && body.amount != null ? r2(num(body.amount)) : d.amount; if (ok && !(amt > 0)) throw new HttpErr(400, 'Bad amount');
    run('UPDATE deposits SET status=?, decided=?, amount=?, admin_note=? WHERE id=?', ok ? 'approved' : 'rejected', Date.now(), amt, str(body.note, 300), d.id);
    if (ok) run('UPDATE users SET bal=bal+? WHERE id=?', amt, d.user_id); log(A, 'deposit-' + mt[2], `#${d.id} ₹${amt}`); return send(res, 200, {});
  }
  if (p === '/deposit-addresses') {
    if (m === 'GET') return send(res, 200, { list: q("SELECT k,v FROM settings WHERE k LIKE 'dep:%' ORDER BY k").map(r => { const [c, n] = r.k.slice(4).split(':'); return { coin: c, network: n, address: r.v }; }) });
    const coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase(); if (!/^[A-Z0-9]{2,12}$/.test(coin) || !/^[A-Z0-9]{2,12}$/.test(net)) throw new HttpErr(400, 'Bad coin/network');
    if (m === 'PUT') { const a = str(body.address, 200); if (a.length < 10) throw new HttpErr(400, 'Address too short'); setSet(`dep:${coin}:${net}`, a); log(A, 'deposit-address', `${coin}/${net} → ${a}`); return send(res, 200, {}); }
    if (m === 'DELETE') { run('DELETE FROM settings WHERE k=?', `dep:${coin}:${net}`); log(A, 'deposit-address-delete', `${coin}/${net}`); return send(res, 200, {}); }
  }
  if (p === '/settings') {
    if (m === 'GET') return send(res, 200, { admin: A, tg_token: getSet('tg_token') ? '••••' : '', tg_chat: getSet('tg_chat') || '', tgEnv: !!process.env.TELEGRAM_BOT_TOKEN });
    if (m === 'PUT') { if (body.tg_token && !/^•+$/.test(body.tg_token)) setSet('tg_token', str(body.tg_token, 200)); if (body.tg_token === '') setSet('tg_token', ''); setSet('tg_chat', str(body.tg_chat, 50)); log(A, 'settings', 'telegram'); return send(res, 200, {}); }
  }
  if (p === '/test-notify' && m === 'POST') { await notify('✅ GXPLAY admin: test notification'); return send(res, 200, {}); }
  if (p === '/change-password' && m === 'POST') {
    if (!verify(String(body.current || ''), adm.pw)) throw new HttpErr(400, 'Current password wrong'); const pw = String(body.pas
