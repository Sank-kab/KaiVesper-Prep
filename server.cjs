/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {pickFile, pickFolder, openInExplorer} = require('./lib/win-dialogs.cjs');
const {resolveWindowsNup, nupEnv, inspectSw1Folder, VENV_DIR, DEFAULT_OUT_BASE} = require('./prepare-win.cjs');
const {
  DEFAULT_PATCHED_DIR,
  detectDocker,
  detectWslNode,
  toWslPath,
  inspectKaihenDir,
  listLanIps,
  findNs2jbDir,
  ensureNs2jb
} = require('./kaihen-win.cjs');

const PORT = Number(process.env.KV_PREP_PORT || 47822);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const sseClients = new Set();
const job = {proc: null, kind: null, status: 'idle', lastOutput: null, logs: []};
const kaihenJob = {
  proc: null,
  status: 'idle',
  ready: false,
  dir: null,
  ip: null,
  smileBasicCmd: null,
  wslPrefix: null,
  stopping: false,
  logs: []
};

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

function getKaihenState() {
  return {
    status: kaihenJob.status,
    ready: kaihenJob.ready,
    dir: kaihenJob.dir,
    ip: kaihenJob.ip,
    smileBasicCmd: kaihenJob.smileBasicCmd,
    logs: kaihenJob.logs.slice(-150)
  };
}

function pushKaihenLog(stream, text) {
  let stateChanged = false;
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (!line) continue;
    const entry = {ts: new Date().toLocaleTimeString(), stream, line};
    kaihenJob.logs.push(entry);
    if (kaihenJob.logs.length > 500) kaihenJob.logs.shift();
    broadcast('kaihen-log', entry);

    const cmdMatch = line.match(/\bV=START\([^)]+\)/);
    if (cmdMatch && kaihenJob.smileBasicCmd !== cmdMatch[0]) {
      kaihenJob.smileBasicCmd = cmdMatch[0];
      stateChanged = true;
    }
    if (/HEN launch completed!/i.test(line) && !kaihenJob.ready) {
      kaihenJob.ready = true;
      stateChanged = true;
    }
  }
  if (stateChanged) broadcast('kaihen-state', getKaihenState());
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

function stopKaihen() {
  const proc = kaihenJob.proc;
  if (proc) killProcessTree(proc);
  if (process.platform === 'win32' && kaihenJob.wslPrefix) {
    // taskkill only ends wsl.exe; the Linux-side node processes must be stopped inside WSL
    try {
      const k = spawn('wsl.exe', [...kaihenJob.wslPrefix, 'bash', '-s'], {windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']});
      k.on('error', () => {});
      k.stdin.on('error', () => {});
      k.stdin.end("pkill -f '/[.]kaivesper-prep/ns2jb/'; exit 0\n");
    } catch {}
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

function checkNup() {
  const {pyBin, pyArgs} = resolveWindowsNup();
  return new Promise(resolve => {
    execFile(pyBin, [...pyArgs, '-c', 'import zstandard, nup.cli; print("NUP_OK")'], {
      windowsHide: true, timeout: 5000, env: nupEnv()
    }, (err, stdout) => {
      const valid = !err && String(stdout || '').includes('NUP_OK');
      resolve({ok: valid, bin: pyBin});
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
      execFile(pipExe, ['install', '--upgrade', 'zstandard>=0.22'], {windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024}, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message).trim()));
        resolve(String(stdout || '').trim() || 'zstandard installed — bundled nup is ready on Windows!');
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
  return {status: job.status, kind: job.kind, lastOutput: job.lastOutput, logs: job.logs.slice(-150)};
}

function startWorker(scriptName, flag, payload, kind) {
  job.logs = [];
  job.kind = kind || null;
  job.status = 'running';
  job.lastOutput = null;
  broadcast('state', getJobState());

  const proc = spawn(process.execPath, [path.join(__dirname, scriptName), flag, JSON.stringify(payload)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  job.proc = proc;
  proc.on('message', msg => {
    if (msg && typeof msg.output === 'string') job.lastOutput = msg.output;
  });
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

async function launchKaihen({kaihenDir, ip, ns2jbDir}) {
  const targetDir = path.resolve(String(kaihenDir || DEFAULT_PATCHED_DIR).trim());
  const info = inspectKaihenDir(targetDir);
  if (!info.valid) {
    throw new Error(`Invalid kaiHEN folder (missing ro/main, hen/main, or bootstrap.bin): ${targetDir}`);
  }

  kaihenJob.logs = [];
  kaihenJob.status = 'running';
  kaihenJob.stopping = false;
  kaihenJob.ready = false;
  kaihenJob.dir = targetDir;
  kaihenJob.ip = ip || null;
  kaihenJob.smileBasicCmd = null;
  kaihenJob.wslPrefix = null;
  broadcast('kaihen-state', getKaihenState());

  let resolvedNs2jb;
  try {
    resolvedNs2jb = await ensureNs2jb(ns2jbDir, msg => pushKaihenLog('info', msg));
  } catch (err) {
    kaihenJob.status = 'error';
    pushKaihenLog('stderr', 'Failed to prepare ns2jb: ' + (err.message || err));
    broadcast('kaihen-state', getKaihenState());
    return;
  }

  if (!info.patched) {
    pushKaihenLog('info', 'Note: This folder does not contain .kaivesper-patched.json (if stock kaiHEN, use "Patch & Build kaiHEN" first for on-console Hot-Swap!).');
  }

  let proc;
  if (process.platform === 'win32') {
    const wslNode = await detectWslNode();
    if (!wslNode.ok) {
      kaihenJob.status = 'error';
      pushKaihenLog('stderr', 'WSL2 with Node.js is required to run ns2jb (hen.cjs) on Windows because ns2jb uses Linux Unix domain sockets (.sock).');
      pushKaihenLog('stderr', 'Install WSL2 (wsl --install) and Node.js 18+ inside WSL, then try Launch kaiHEN again.');
      broadcast('kaihen-state', getKaihenState());
      return;
    }
    const wslNs2jbSrc = toWslPath(resolvedNs2jb);
    const wslTargetDir = toWslPath(targetDir);
    const ipArg = (ip && String(ip).trim()) ? String(ip).trim() : '';
    const prefix = wslNode.distro ? ['-d', wslNode.distro, '--'] : ['--'];
    kaihenJob.wslPrefix = prefix;
    const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const script = [
      '#!/bin/bash',
      'set -eu',
      'mkdir -p "$HOME/.kaivesper-prep/ns2jb"',
      'cp -ru ' + shq(wslNs2jbSrc) + '/. "$HOME/.kaivesper-prep/ns2jb/"',
      'cd "$HOME/.kaivesper-prep/ns2jb"',
      'exec ' + shq(wslNode.nodeBin) + ' "$HOME/.kaivesper-prep/ns2jb/hen.cjs" --dir ' + shq(wslTargetDir) + (ipArg ? ' ' + shq(ipArg) : '')
    ].join('\n') + '\n';
    const scriptWin = path.join(require('node:os').tmpdir(), 'kv-launch-kaihen.sh');
    fs.writeFileSync(scriptWin, script, {encoding: 'utf8'});
    pushKaihenLog('info', `Launching kaiHEN via WSL (${wslNode.version}): node hen.cjs --dir "${wslTargetDir}"${ipArg ? ' ' + ipArg : ''}`);
    proc = spawn('wsl.exe', [...prefix, 'bash', toWslPath(scriptWin)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } else {
    const henScript = path.join(resolvedNs2jb, 'hen.cjs');
    const args = [henScript, '--dir', targetDir];
    if (ip && String(ip).trim()) args.push(String(ip).trim());
    pushKaihenLog('info', `Launching kaiHEN: node hen.cjs --dir "${targetDir}"${ip ? ' ' + ip : ''}`);
    proc = spawn(process.execPath, args, {
      cwd: resolvedNs2jb,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }
  kaihenJob.proc = proc;
  proc.stdout.on('data', d => pushKaihenLog('stdout', d));
  proc.stderr.on('data', d => pushKaihenLog('stderr', d));
  proc.on('error', err => pushKaihenLog('stderr', 'Process error: ' + err.message));
  proc.on('close', code => {
    const wasReady = kaihenJob.ready;
    kaihenJob.proc = null;
    if (!kaihenJob.stopping) stopKaihen();
    kaihenJob.status = kaihenJob.stopping ? 'idle' : ((code === 0 || wasReady) ? 'done' : 'error');
    pushKaihenLog('info', `--- kaiHEN launcher exited (code ${code}) ---`);
    broadcast('kaihen-state', getKaihenState());
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
      res.write(`event: state\ndata: ${JSON.stringify(getJobState())}\n\n`);
      res.write(`event: kaihen-state\ndata: ${JSON.stringify(getKaihenState())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname === '/api/env' && req.method === 'GET') {
      const [py, nup, docker] = await Promise.all([checkPython(), checkNup(), detectDocker()]);
      const defaultKaihenInfo = inspectKaihenDir(DEFAULT_PATCHED_DIR);
      return sendJson(res, 200, {
        apiVersion: 3,
        node: process.version,
        python: py,
        nup,
        docker,
        drives: detectDrives(),
        lanIps: listLanIps(),
        ns2jbDir: findNs2jbDir(null),
        defaultPatchedKaihen: defaultKaihenInfo,
        defaultOut: DEFAULT_OUT_BASE,
        job: getJobState(),
        kaihen: getKaihenState()
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
      startWorker('prepare-win.cjs', '--prepare-json', body, 'nup');
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
      startWorker('prepare-win.cjs', '--prepare-sw1-json', body, 'sw1');
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/kaihen/patch' && req.method === 'POST') {
      if (job.proc) return sendJson(res, 409, {error: 'A task is already running!'});
      const body = await readBody(req);
      startWorker('kaihen-win.cjs', '--patch-json', body, 'kaihen-patch');
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/kaihen/inspect' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, inspectKaihenDir(body.path));
    }

    if (pathname === '/api/kaihen/start' && req.method === 'POST') {
      if (kaihenJob.proc) return sendJson(res, 409, {error: 'kaiHEN launcher is already running!'});
      const body = await readBody(req);
      const targetDir = path.resolve(String(body.kaihenDir || DEFAULT_PATCHED_DIR).trim());
      if (!inspectKaihenDir(targetDir).valid) {
        return sendJson(res, 400, {error: `Selected folder is not a valid kaiHEN package (missing ro/main, hen/main, or bootstrap.bin): ${targetDir}`});
      }
      launchKaihen(body).catch(err => {
        kaihenJob.status = 'error';
        pushKaihenLog('stderr', err.message || String(err));
        broadcast('kaihen-state', getKaihenState());
      });
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/kaihen/stop' && req.method === 'POST') {
      if (kaihenJob.proc) {
        kaihenJob.stopping = true;
        stopKaihen();
        pushKaihenLog('info', 'kaiHEN launcher stopped by user.');
      }
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/kaihen/stdin' && req.method === 'POST') {
      const body = await readBody(req);
      if (!kaihenJob.proc || !kaihenJob.proc.stdin) {
        return sendJson(res, 400, {error: 'kaiHEN launcher is not running.'});
      }
      const line = String(body.text ?? '');
      kaihenJob.proc.stdin.write(line + '\n');
      pushKaihenLog('info', `> ${line}`);
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
      if (!body.path || !fs.existsSync(body.path)) {
        return sendJson(res, 404, {error: 'Output folder not found: ' + (body.path || '(empty)')});
      }
      await openInExplorer(body.path);
      return sendJson(res, 200, {ok: true});
    }

    if (pathname === '/api/shutdown' && req.method === 'POST') {
      sendJson(res, 200, {ok: true});
      if (job.proc) killProcessTree(job.proc);
      if (kaihenJob.proc) stopKaihen();
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
