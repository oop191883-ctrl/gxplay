'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch (e) {}

const PORT = +process.env.PORT || 3000;
let DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA, { recursive: true }); fs.accessSync(DATA, fs.constants.W_OK); }
catch (e) { console.log('WARNING: DATA_DIR ' + DATA + ' not writable (' + e.code + '). Using local ./data - data may be lost on redeploy. Attach a disk!'); DATA = path.join(__dirname, 'data'); fs.mkdirSync(DATA, { recursive: true }); }
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

