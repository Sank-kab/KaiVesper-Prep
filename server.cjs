/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {pickFile, pickFolder, openInExplorer} = require('./lib/win-dialogs.cjs');
const {resolveWindowsNup, inspectSw1Folder, VENV_DIR, DEFAULT_OUT_BASE} = require('./prepare-win.cjs');

const PORT = Number(process.env.KV_PREP_PORT || 47822);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const sseClients = new Set();
const job = {proc: null, status: 'idle', lastOutput: null, logs: []};

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function pushLog(stream, text) {
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (!line) continue;
    const entry = {ts: new Date().toLocaleTimeString(), stream, line};
    job.logs.push(entry);
    if (job.logs.length > 500) job.logs.shift();
    broadcast('log', entry);
    const m = line.match(/^\s+([A-Za-z]:\\.+)$/);
    if (m) job.lastOutput = m[1].trim();
  }
}

function detectDrives() {
  const drives = [];
  for (let c = 68; c <= 90; c++) { // D:..Z:
    const letter = String.fromCharCode(c);
    try {
      if (fs.existsSync(`${letter}:\\`)) {
        const hasModloader = fs.existsSync(`${letter}:\\ns2jb-modloader`);
        drives.push({letter, hasModloader});
      }
    } catch {}
  }
  return drives;
}

function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {windowsHide: true}, () => {
      try { proc.kill(); } catch {}
    });
  } else {
    try { proc.kill(); } catch {}
  }
}

function checkPython() {
  const tryCmd = (bin, args) => new Promise(resolve => {
    execFile(bin, [...args, '--version'], {windowsHide: true, timeout: 5000}, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const ver = String(stdout || stderr || '').trim();
      if (!/^Python\s+3\./i.test(ver)) return resolve(null);
      resolve({ok: true, bin, args, version: ver});
    });
  });
  return tryCmd('python', []).then(res => res || tryCmd('py', ['-3'])).then(res => res || {ok: false, bin: null, args: [], version: 'Missing'});
}

const NUP_PACKAGE_SPEC = 'https://github.com/a55uka/nup/archive/refs/heads/main.zip#subdirectory=tools/nup';

function checkNup() {
  const {nupBin} = resolveWindowsNup();
  return new Promise(resolve => {
    execFile(nupBin, ['--help'], {windowsHide: true, timeout: 5000}, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      const valid = !err && out.includes('extract') && out.includes('info');
      resolve({ok: valid, bin: nupBin});
    });
  });
}

async function installNupNative() {
  const py = await checkPython();
  if (!py.ok) throw new Error('Python 3.10+ not found on Windows. Install Python from python.org first.');
  return new Promise((resolve, reject) => {
    const pyExe = path.join(VENV_DIR, 'Scripts', 'python.exe');
    const pipExe = path.join(VENV_DIR, 'Scripts', 'pip.exe');
    const stepPip = () => {
      execFile(pipExe, ['install', '--upgrade', '--force-reinstall', NUP_PACKAGE_SPEC], {windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024}, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message).trim()));
        resolve(String(stdout || '').trim() || 'nup (a55uka/nup) installed on Windows!');
      });
    };
    if (fs.existsSync(pipExe) && fs.existsSync(pyExe)) return stepPip();
    fs.mkdirSync(path.dirname(VENV_DIR), {recursive: true});
    execFile(py.bin, [...py.args, '-m', 'venv', VENV_DIR], {windowsHide: true, timeout: 60000}, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).trim()));
      stepPip();
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (settled) return;
      raw += chunk;
      if (raw.length > 256 * 1024) {
        settled = true;
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON payload')); }
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

function getJobState() {
  return {status: job.status, lastOutput: job.lastOutput, logs: job.logs.slice(-150)};
}

function startWorker(flag, payload) {
  job.logs = [];
  job.status = 'running';
  job.lastOutput = null;
  broadcast('state', getJobState());

  const proc = spawn(process.execPath, [path.join(__dirname, 'prepare-win.cjs'), flag, JSON.stringify(payload)], {windowsHide: true});
  job.proc = proc;
  proc.stdout.on('data', d => pushLog('stdout', d));
  proc.stderr.on('data', d => pushLog('stderr', d));
  proc.on('error', err => pushLog('stderr', 'Process error: ' + err.message));
  proc.on('close', code => {
    job.proc = null;
    job.status = code === 0 ? 'done' : 'error';
    pushLog('info', `--- Finished (exit code ${code}) ---`);
    broadcast('state', getJobState());
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
      res.write(`event: state\ndata: ${JSON.stringify(getJobState())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname === '/api/env' && req.method === 'GET') {
      const [py, nup] = await Promise.all([checkPython(), checkNup()]);
      return sendJson(res, 200, {
        node: process.version,
        python: py,
        nup,
        drives: detectDrives(),
        defaultOut: DEFAULT_OUT_BASE,
        job: getJobState()
      });
    }

    if (pathname === '/api/install-nup' && req.method === 'POST') {
      const output = await installNupNative();
      const nup = await checkNup();
      return sendJson(res, 200, {ok: true, output, nup});
    }

    if (pathname === '/api/prepare/start' && req.method === 'POST') {
      if (job.proc) return sendJson(res, 409, {error: 'A task is already running!'});
      const body = await readBody(req);
      startWorker('--prepare-json', body);
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/sw1/inspect' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.path) return sendJson(res, 400, {error: 'Missing folder path'});
      return sendJson(res, 200, inspectSw1Folder(body.path));
    }

    if (pathname === '/api/sw1/start' && req.method === 'POST') {
      if (job.proc) return sendJson(res, 409, {error: 'A task is already running!'});
      const body = await readBody(req);
      startWorker('--prepare-sw1-json', body);
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/prepare/stop' && req.method === 'POST') {
      if (job.proc) {
        killProcessTree(job.proc);
        pushLog('info', 'Operation cancelled by user.');
      }
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/dialog/file' && req.method === 'POST') {
      const body = await readBody(req);
      const filter = body.kind === 'romfs'
        ? 'RomFS Image (romfs.bin;*.bin)|*.bin|All files (*.*)|*.*'
        : 'NUP Package (*.nup)|*.nup|All files (*.*)|*.*';
      const title = body.kind === 'romfs' ? 'Select romfs.bin file' : 'Select .nup package to extract';
      const chosen = await pickFile({title, filter});
      return sendJson(res, 200, {path: chosen});
    }

    if (pathname === '/api/dialog/folder' && req.method === 'POST') {
      const body = await readBody(req);
      const desc = body.description || 'Select folder';
      const chosen = await pickFolder({description: desc});
      return sendJson(res, 200, {path: chosen});
    }

    if (pathname === '/api/open-folder' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.path && fs.existsSync(body.path)) openInExplorer(body.path);
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/shutdown' && req.method === 'POST') {
      sendJson(res, 200, {ok: true});
      if (job.proc) killProcessTree(job.proc);
      for (const c of sseClients) { try { c.end(); } catch {} }
      setTimeout(() => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 400).unref(); }, 150);
      return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); return res.end('Not Found');
    }
    res.writeHead(200, {'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    sendJson(res, 500, {error: err.message || String(err)});
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log(`KaiVesper Prep (Windows Native) listening on http://127.0.0.1:${PORT}`));
}
module.exports = {server, PORT};
