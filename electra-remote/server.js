#!/usr/bin/env node
/**
 * Electra Smart proxy + static server for the remote.
 *
 *   node server.js            → http://localhost:8787
 *   PORT=3000 node server.js
 *
 * Zero dependencies, needs Node 18 or newer (built-in fetch).
 *
 * Why a proxy: the Electra Smart cloud (app.ecpiot.co.il) does not send CORS
 * headers, so a browser page cannot call it directly. This server forwards the
 * few calls the remote needs. It keeps no credentials of its own: the browser
 * sends its token / imei / sid on every request in headers, the same way the
 * official mobile app does with its own session.
 *
 * Protocol notes (same vocabulary the Electra app and Home Assistant use):
 *   SEND_OTP        { phoneNumber }
 *   CHECK_OTP       { imei, phoneNumber, otp, os, osver }  → token, sid
 *   VALIDATE_TOKEN  { imei, token, os, osver }             → sid
 *   GET_DEVICES     {}                                     → devices[]
 *   GET_LAST_TELEMETRY { id, commandName: "OPER,DIAG_L2" } → commandJson.OPER (JSON string)
 *   SEND_COMMAND    { id, commandJson: '{"OPER":{...}}' }
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const ELECTRA_URL = process.env.ELECTRA_URL || 'https://app.ecpiot.co.il/mobile/mobilecommand';
const OS = 'android';
const OSVER = 'M4B30Z';
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

/* ---------- Electra cloud calls ---------- */
async function electra(cmd, data, sid) {
  const res = await fetch(ELECTRA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Electra Client' },
    body: JSON.stringify({ pvdid: 1, id: 99, sid: sid || null, cmd, data }),
  });
  if (!res.ok) throw new Error(`Electra HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 0) throw new Error(`Electra status ${j.status}: ${j.desc || 'unknown error'}`);
  if (j.data && typeof j.data.res === 'number' && j.data.res !== 0) {
    const err = new Error(`Electra res ${j.data.res}: ${j.data.res_desc || 'command rejected'}`);
    err.res = j.data.res;
    throw err;
  }
  return j.data || {};
}

function newImei() {
  return '2b950000' + String(Math.floor(10000000 + Math.random() * 89999999));
}

async function newSid(auth) {
  const d = await electra('VALIDATE_TOKEN', { imei: auth.imei, token: auth.token, os: OS, osver: OSVER });
  if (!d.sid) throw new Error('Electra did not return a session id; log in again');
  return d.sid;
}

/** Runs a command with the caller's session; renews the session once if it expired. */
async function withSession(auth, fn) {
  if (!auth.token || !auth.imei) throw httpError(401, 'not logged in');
  let sid = auth.sid;
  if (!sid) sid = await newSid(auth);
  try {
    return { result: await fn(sid), sid };
  } catch (e) {
    if (!auth.sid || e.res === undefined) throw e;
    sid = await newSid(auth);
    return { result: await fn(sid), sid };
  }
}

function parseJsonField(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/* ---------- HTTP plumbing ---------- */
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(httpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(httpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(obj));
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Electra-Token, X-Electra-Imei, X-Electra-Sid',
  'Access-Control-Max-Age': '86400',
};

async function handleApi(req, res, url) {
  const auth = { token: req.headers['x-electra-token'] || '', imei: req.headers['x-electra-imei'] || '', sid: req.headers['x-electra-sid'] || '' };
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'POST' && url.pathname === '/api/otp/send') {
    const { phone } = await readBody(req);
    if (!/^0\d{8,9}$/.test(phone || '')) throw httpError(400, 'phone must look like 05xxxxxxxx');
    await electra('SEND_OTP', { phoneNumber: phone });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/otp/verify') {
    const { phone, otp } = await readBody(req);
    if (!phone || !otp) throw httpError(400, 'phone and otp are required');
    const imei = newImei();
    const d = await electra('CHECK_OTP', { imei, phoneNumber: phone, otp: String(otp), os: OS, osver: OSVER });
    if (!d.token) throw httpError(502, 'Electra did not return a token; check the code and try again');
    return sendJson(res, 200, { ok: true, token: d.token, imei, sid: d.sid || '' });
  }

  if (req.method === 'GET' && url.pathname === '/api/devices') {
    const { result, sid } = await withSession(auth, (sid) => electra('GET_DEVICES', {}, sid));
    const devices = (result.devices || [])
      .filter((d) => !d.deviceTypeName || /A\.?C|Air|Split/i.test(d.deviceTypeName) || d.deviceTypeName.length < 40)
      .map((d) => ({ id: d.id, name: d.name, model: d.model, deviceTypeName: d.deviceTypeName, mac: d.mac, sn: d.sn }));
    return sendJson(res, 200, { ok: true, sid, devices });
  }

  if (parts[0] === 'api' && parts[1] === 'devices' && parts[2] && parts[3] === 'state' && req.method === 'GET') {
    const id = Number(parts[2]);
    const { result, sid } = await withSession(auth, (sid) => electra('GET_LAST_TELEMETRY', { id, commandName: 'OPER,DIAG_L2' }, sid));
    const cj = result.commandJson || {};
    const oper = parseJsonField(cj.OPER); const diag = parseJsonField(cj.DIAG_L2);
    return sendJson(res, 200, { ok: true, sid, oper: (oper && oper.OPER) || oper, diag: (diag && diag.DIAG_L2) || diag, timestamp: result.timestamp || null });
  }

  if (parts[0] === 'api' && parts[1] === 'devices' && parts[2] && parts[3] === 'command' && req.method === 'POST') {
    const id = Number(parts[2]);
    const { oper } = await readBody(req);
    if (!oper || typeof oper !== 'object') throw httpError(400, 'oper object is required');
    const { sid } = await withSession(auth, (sid) => electra('SEND_COMMAND', { id, commandJson: JSON.stringify({ OPER: oper }) }, sid));
    return sendJson(res, 200, { ok: true, sid });
  }

  throw httpError(404, 'unknown API route');
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || file.includes('server.js')) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); }
    catch (e) {
      const status = e.status || 502;
      console.error(new Date().toISOString(), req.method, url.pathname, '->', e.message);
      sendJson(res, status, { ok: false, error: e.message });
    }
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Electra remote:  http://localhost:${PORT}`);
  console.log(`Electra cloud:   ${ELECTRA_URL}`);
});
