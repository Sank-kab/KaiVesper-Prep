/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn, execFile} = require('node:child_process');

const KAIHEN_TAG = '20261117.1';
const KAIHEN_RELEASE_ZIP_URL = `https://github.com/ouncebrew/kaihen/releases/download/${KAIHEN_TAG}/kaiHEN-${KAIHEN_TAG}.zip`;
const KAIHEN_SRC_ZIP_URL = `https://github.com/ouncebrew/kaihen/archive/refs/tags/${KAIHEN_TAG}.zip`;
const DEVKIT_SRC_ZIP_URL = 'https://github.com/ouncebrew/ounce-devkit/archive/refs/heads/main.zip';
const NS2JB_ZIP_URL = 'https://gitlab.com/kurumuz/ns2jb/-/archive/main/ns2jb-main.zip';
const PATCH_BASE_URL = 'https://raw.githubusercontent.com/nicholasyoannou/switch2-modbridge/main/kaihen/patches';
const PATCH_FILES = [
  '0001-Add-ns2jb-helper-commands-to-ro-dmnt-and-an-FS-proce.patch',
  '0002-ro-dmnt-accept-ns2jb-modloader-s-helper-requests-and.patch',
  '0003-ro-dmnt-map-code-source-must-be-heap-type-5-as-in-th.patch',
];

const BASE_DATA_DIR = path.join(os.homedir(), '.kaivesper-prep');
const DEFAULT_PATCHED_DIR = path.join(BASE_DATA_DIR, `kaiHEN-${KAIHEN_TAG}-kaivesper-patched`);
const DEFAULT_NS2JB_DIR = path.join(BASE_DATA_DIR, 'ns2jb');
const DEFAULT_DOCKER_IMAGE = 'ounce-devkit:latest';

function execQuiet(bin, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(bin, args, {windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024}, (err, stdout, stderr) => {
      resolve({ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), err});
    });
  });
}

function runStreaming(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts});
    let stderrTail = '';
    p.stdout.on('data', d => {
      if (opts.onLog) opts.onLog(d.toString());
      else process.stdout.write(d);
    });
    p.stderr.on('data', d => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      if (opts.onLog) opts.onLog(s);
      else process.stderr.write(d);
    });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited with code ${code}${stderrTail ? '\n' + stderrTail.trim() : ''}`));
    });
  });
}

async function detectDocker(imageName = DEFAULT_DOCKER_IMAGE) {
  const nat = await execQuiet('docker', ['info', '--format', '{{.ServerVersion}}'], 6000);
  if (nat.ok && nat.stdout) {
    const img = await execQuiet('docker', ['image', 'inspect', '--format', '{{.Id}}', imageName], 5000);
    return {ok: true, mode: 'native', distro: null, version: nat.stdout, hasDevkitImage: img.ok && !!img.stdout};
  }
  if (process.platform === 'win32') {
    const wslAttempts = [
      {distro: null, prefix: ['--']},
      {distro: 'Ubuntu', prefix: ['-d', 'Ubuntu', '--']},
    ];
    for (const att of wslAttempts) {
      const res = await execQuiet('wsl.exe', [...att.prefix, 'docker', 'info', '--format', '{{.ServerVersion}}'], 8000);
      if (res.ok && res.stdout) {
        const img = await execQuiet('wsl.exe', [...att.prefix, 'docker', 'image', 'inspect', '--format', '{{.Id}}', imageName], 6000);
        return {ok: true, mode: 'wsl', distro: att.distro, version: res.stdout, hasDevkitImage: img.ok && !!img.stdout};
      }
    }
  }
  return {ok: false, mode: null, distro: null, version: null, hasDevkitImage: false};
}

function dockerCmd(dockerInfo, dockerArgs) {
  if (dockerInfo.mode === 'native') return {bin: 'docker', args: dockerArgs};
  const prefix = dockerInfo.distro ? ['-d', dockerInfo.distro, '--'] : ['--'];
  return {bin: 'wsl.exe', args: [...prefix, 'docker', ...dockerArgs]};
}

function toWslPath(winPath) {
  const abs = path.resolve(winPath);
  const m = abs.match(/^([A-Za-z]):\\(.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  return abs.replace(/\\/g, '/');
}

function toDockerHostPath(winPath, dockerInfo) {
  if (dockerInfo.mode === 'native') return path.resolve(winPath);
  return toWslPath(winPath);
}

async function detectWslNode() {
  if (process.platform !== 'win32') return {ok: true, distro: null, nodeBin: process.execPath, version: process.version};
  const findScript = 'n=$(command -v node 2>/dev/null || true); if [ -z "$n" ]; then for p in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node /usr/local/bin/node /usr/bin/node; do [ -x "$p" ] && n="$p"; done; fi; if [ -x "$n" ]; then echo "$n"; "$n" -v; fi\n';
  const attempts = [
    {distro: null, prefix: []},
    {distro: 'Ubuntu', prefix: ['-d', 'Ubuntu']},
  ];
  for (const att of attempts) {
    const res = await new Promise(resolve => {
      const p = spawn('wsl.exe', [...att.prefix, '--', 'bash', '-s'], {windowsHide: true});
      let out = '';
      const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(''); }, 10000);
      p.stdout.on('data', d => { out += d; });
      p.on('error', () => { clearTimeout(timer); resolve(''); });
      p.on('close', () => { clearTimeout(timer); resolve(out); });
      p.stdin.on('error', () => {});
      p.stdin.end(findScript);
    });
    const lines = String(res).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 2 && /^v\d+\./.test(lines[1])) {
      return {ok: true, distro: att.distro, nodeBin: lines[0], version: lines[1]};
    }
  }
  return {ok: false, distro: null, nodeBin: null, version: null};
}

async function downloadFile(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), {recursive: true});
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {'User-Agent': 'KaiVesper-Prep/1.0', 'Accept': '*/*'}
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buf);
      return buf.length;
    }
    if (process.platform !== 'win32') throw new Error(`HTTP ${res.status} downloading ${url}`);
  } catch (err) {
    if (process.platform !== 'win32') throw err;
  }
  const r = await execQuiet('curl.exe', ['-fsSL', '--retry', '2', '-o', destPath, url], 120000);
  if (!r.ok || !fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
    throw new Error(`Download failed for ${url}: ${r.stderr || r.stdout || r.err?.message || 'empty file'}`);
  }
  return fs.statSync(destPath).size;
}

async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, {recursive: true});
  const psScript = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
  const r = await execQuiet('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], 120000);
  if (!r.ok) throw new Error(`ZIP extraction failed: ${r.stderr || r.stdout || r.err?.message}`);
}

function findDirContaining(rootDir, relPaths, maxDepth = 4) {
  const check = dir => relPaths.every(rp => fs.existsSync(path.join(dir, rp)));
  const walk = (dir, depth) => {
    if (check(dir)) return dir;
    if (depth >= maxDepth) return null;
    for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
      if (!ent.isDirectory()) continue;
      const found = walk(path.join(dir, ent.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(rootDir, 0);
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function inspectKaihenDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return {valid: false, patched: false, path: dirPath || null};
  const hasRo = fs.existsSync(path.join(dirPath, 'ro', 'main'));
  const hasBoot = fs.existsSync(path.join(dirPath, 'bootstrap.bin'));
  const hasHenFlat = fs.existsSync(path.join(dirPath, 'hen', 'main'));
  const hasHenSd = fs.existsSync(path.join(dirPath, 'sdcard', 'kaihen', 'bin', 'hen', 'main'));
  const valid = hasRo && hasBoot && (hasHenFlat || hasHenSd);
  let meta = null;
  const metaPath = path.join(dirPath, '.kaivesper-patched.json');
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }
  return {valid, patched: !!meta, meta, path: path.resolve(dirPath)};
}

function listLanIps() {
  const ifaces = os.networkInterfaces();
  const seen = new Set();
  const items = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.netmask === '255.255.255.255') continue;
      if (a.address.startsWith('169.254.')) continue;
      if (seen.has(a.address)) continue;
      seen.add(a.address);
      const isVirtual = /vethernet|wsl|hyper-v|docker|virtualbox|vmware|tailscale|zerotier|loopback/i.test(name);
      const isPrivateLan = a.address.startsWith('192.168.') || a.address.startsWith('10.');
      const score = (isVirtual ? 0 : 10) + (isPrivateLan ? 5 : 0);
      items.push({ip: a.address, iface: name, preferred: !isVirtual && isPrivateLan, _score: score});
    }
  }
  items.sort((a, b) => b._score - a._score || a.ip.localeCompare(b.ip));
  return items.map(({ip, iface, preferred}) => ({ip, iface, preferred}));
}

function findNs2jbDir(customDir) {
  const candidates = [];
  if (customDir) candidates.push(path.resolve(customDir));
  candidates.push(DEFAULT_NS2JB_DIR);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'hen.cjs')) && fs.existsSync(path.join(dir, 'run.cjs'))) {
      return dir;
    }
  }
  return null;
}

async function ensureNs2jb(customDir, onLog = msg => console.log(msg)) {
  const existing = findNs2jbDir(customDir);
  if (existing) return existing;

  onLog(`Downloading ns2jb (hen.cjs) from ${NS2JB_ZIP_URL}...`);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-ns2jb-'));
  try {
    const zipPath = path.join(tmpRoot, 'ns2jb.zip');
    const bytes = await downloadFile(NS2JB_ZIP_URL, zipPath);
    onLog(`  Downloaded ${(bytes / 1024).toFixed(1)} KB. Extracting...`);
    const extDir = path.join(tmpRoot, 'ext');
    await extractZip(zipPath, extDir);
    const found = findDirContaining(extDir, ['hen.cjs', 'run.cjs']);
    if (!found) throw new Error('Downloaded ns2jb archive is missing hen.cjs / run.cjs');
    fs.rmSync(DEFAULT_NS2JB_DIR, {recursive: true, force: true});
    fs.mkdirSync(path.dirname(DEFAULT_NS2JB_DIR), {recursive: true});
    fs.cpSync(found, DEFAULT_NS2JB_DIR, {recursive: true, force: true});
    onLog(`ns2jb ready at ${DEFAULT_NS2JB_DIR}`);
    return DEFAULT_NS2JB_DIR;
  } finally {
    try { fs.rmSync(tmpRoot, {recursive: true, force: true}); } catch {}
  }
}

async function patchAndBuildKaihen(opts = {}) {
  const log = msg => console.log(msg);
  const dockerImage = opts.dockerImage || DEFAULT_DOCKER_IMAGE;

  log('========================================================');
  log(`  KaiVesper Prep — 1-Click Patched kaiHEN Builder (${KAIHEN_TAG})`);
  log('========================================================');

  log('[1/6] Checking Docker environment...');
  const docker = await detectDocker(dockerImage);
  if (!docker.ok) {
    throw new Error(
      'Docker not found or not running!\n' +
      'Install Docker Desktop for Windows (https://www.docker.com/products/docker-desktop/) OR start Docker inside WSL2, then try again.'
    );
  }
  log(`  Docker detected (${docker.mode}${docker.distro ? ':' + docker.distro : ''}, engine ${docker.version})`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-kaihen-'));
  try {
    if (!docker.hasDevkitImage) {
      log(`[2/6] Docker image "${dockerImage}" not found — building ounce-devkit (one-time ~1-2 min)...`);
      const dkZip = path.join(tmpRoot, 'ounce-devkit.zip');
      await downloadFile(DEVKIT_SRC_ZIP_URL, dkZip);
      const dkExt = path.join(tmpRoot, 'ounce-devkit');
      await extractZip(dkZip, dkExt);
      const dkDir = findDirContaining(dkExt, ['Dockerfile']);
      if (!dkDir) throw new Error('ounce-devkit archive missing Dockerfile');
      const cmd = dockerCmd(docker, ['build', '-t', dockerImage, toDockerHostPath(dkDir, docker)]);
      await runStreaming(cmd.bin, cmd.args);
      log(`  Image "${dockerImage}" built successfully!`);
    } else {
      log(`[2/6] Docker image "${dockerImage}" is ready!`);
    }

    let stockRoot = null;
    if (opts.stockDir && String(opts.stockDir).trim()) {
      const candidate = path.resolve(String(opts.stockDir).trim());
      if (!inspectKaihenDir(candidate).valid) {
        throw new Error(`Selected stock kaiHEN folder is missing ro/main, hen/main, or bootstrap.bin:\n  ${candidate}`);
      }
      stockRoot = candidate;
      log(`[3/6] Using local stock kaiHEN folder: ${stockRoot}`);
    } else {
      log(`[3/6] Downloading official kaiHEN ${KAIHEN_TAG} release...`);
      const relZip = path.join(tmpRoot, `kaiHEN-${KAIHEN_TAG}.zip`);
      const sz = await downloadFile(KAIHEN_RELEASE_ZIP_URL, relZip);
      log(`  Downloaded ${(sz / 1024).toFixed(1)} KB. Extracting...`);
      const relExt = path.join(tmpRoot, 'release');
      await extractZip(relZip, relExt);
      stockRoot = findDirContaining(relExt, ['ro/main', 'bootstrap.bin']);
      if (!stockRoot) throw new Error('Official kaiHEN release archive layout not recognized (missing ro/main or bootstrap.bin)');
      log(`  Extracted stock release cleanly.`);
    }

    let outDir;
    if (opts.outDir && String(opts.outDir).trim()) {
      outDir = path.resolve(String(opts.outDir).trim());
    } else if (opts.stockDir && String(opts.stockDir).trim()) {
      outDir = path.resolve(String(opts.stockDir).trim()).replace(/[\\\/]+$/, '') + '-kaivesper-patched';
    } else {
      outDir = DEFAULT_PATCHED_DIR;
    }

    log(`[4/6] Downloading kaiHEN ${KAIHEN_TAG} source + 3 ro:dmnt FS helper patches...`);
    const srcZip = path.join(tmpRoot, 'kaihen-src.zip');
    await downloadFile(KAIHEN_SRC_ZIP_URL, srcZip);
    const srcExt = path.join(tmpRoot, 'src-ext');
    await extractZip(srcZip, srcExt);
    const srcDir = findDirContaining(srcExt, ['Makefile', 'ro', 'hen', 'bootstrap']);
    if (!srcDir) throw new Error('kaiHEN source archive missing Makefile / ro / hen / bootstrap');

    const workDir = path.join(tmpRoot, 'work');
    const workSrc = path.join(workDir, 'src');
    const workPatches = path.join(workDir, 'patches');
    const workBuilt = path.join(workDir, 'built');
    fs.mkdirSync(workPatches, {recursive: true});
    fs.mkdirSync(workBuilt, {recursive: true});
    fs.cpSync(srcDir, workSrc, {recursive: true});

    for (const pf of PATCH_FILES) {
      const url = `${PATCH_BASE_URL}/${pf}`;
      const dst = path.join(workPatches, pf);
      const sz = await downloadFile(url, dst);
      // Normalize CRLF -> LF so Linux patch/git apply always applies cleanly
      const text = fs.readFileSync(dst, 'utf8').replace(/\r\n/g, '\n');
      fs.writeFileSync(dst, text, 'utf8');
      log(`  Patch downloaded: ${pf} (${sz} B)`);
    }

    log('[5/6] Applying patches and compiling ro, hen & bootstrap inside Docker...');
    const buildScript = [
      'set -eu',
      'cd /work/src',
      'for p in /work/patches/*.patch; do',
      '  echo "  -> Applying $(basename "$p")"',
      '  if command -v git >/dev/null 2>&1; then',
      '    git apply --whitespace=nowarn "$p"',
      '  else',
      '    patch -p1 --batch --forward < "$p"',
      '  fi',
      'done',
      'echo "  -> Compiling kaiHEN (libkaihen, ro, hen, bootstrap)..."',
      'make -j"$(nproc)"',
      'cp ro/build/main /work/built/ro_main',
      'cp hen/build/main /work/built/hen_main',
      'cp bootstrap/build/bootstrap.bin /work/built/bootstrap.bin',
      'chmod 644 /work/built/ro_main /work/built/hen_main /work/built/bootstrap.bin',
      'echo "  -> Compilation succeeded!"',
    ].join('\n');
    fs.writeFileSync(path.join(workDir, 'build.sh'), buildScript + '\n', 'utf8');

    const hostWork = toDockerHostPath(workDir, docker);
    const runCmd = dockerCmd(docker, [
      'run', '--rm',
      '-v', `${hostWork}:/work`,
      '-w', '/work/src',
      dockerImage,
      'sh', '/work/build.sh'
    ]);
    await runStreaming(runCmd.bin, runCmd.args);

    const builtRo = path.join(workBuilt, 'ro_main');
    const builtHen = path.join(workBuilt, 'hen_main');
    const builtBoot = path.join(workBuilt, 'bootstrap.bin');
    for (const f of [builtRo, builtHen, builtBoot]) {
      if (!fs.existsSync(f) || fs.statSync(f).size < 1024) {
        throw new Error(`Expected built binary missing or empty: ${f}`);
      }
    }

    log(`[6/6] Assembling patched kaiHEN release folder...`);
    if (path.resolve(outDir) !== path.resolve(stockRoot)) {
      fs.rmSync(outDir, {recursive: true, force: true});
      fs.mkdirSync(outDir, {recursive: true});
      fs.cpSync(stockRoot, outDir, {recursive: true, force: true});
    }

    fs.mkdirSync(path.join(outDir, 'ro'), {recursive: true});
    fs.copyFileSync(builtRo, path.join(outDir, 'ro', 'main'));
    fs.copyFileSync(builtBoot, path.join(outDir, 'bootstrap.bin'));

    let henTargetRel = 'hen/main';
    const sdHen = path.join(outDir, 'sdcard', 'kaihen', 'bin', 'hen', 'main');
    if (fs.existsSync(path.join(outDir, 'sdcard'))) {
      fs.mkdirSync(path.dirname(sdHen), {recursive: true});
      fs.copyFileSync(builtHen, sdHen);
      henTargetRel = 'sdcard/kaihen/bin/hen/main';
    }
    if (fs.existsSync(path.join(outDir, 'hen')) || !fs.existsSync(path.join(outDir, 'sdcard'))) {
      fs.mkdirSync(path.join(outDir, 'hen'), {recursive: true});
      fs.copyFileSync(builtHen, path.join(outDir, 'hen', 'main'));
    }

    const meta = {
      tool: 'KaiVesper Prep',
      kaihenVersion: KAIHEN_TAG,
      patchedAt: new Date().toISOString(),
      patches: PATCH_FILES,
      sha256: {
        'ro/main': sha256File(path.join(outDir, 'ro', 'main')),
        [henTargetRel]: sha256File(path.join(outDir, henTargetRel)),
        'bootstrap.bin': sha256File(path.join(outDir, 'bootstrap.bin')),
      }
    };
    fs.writeFileSync(path.join(outDir, '.kaivesper-patched.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

    log('');
    log('Patched binaries installed:');
    log(`  ro/main       : ${fs.statSync(path.join(outDir, 'ro', 'main')).size} B (sha256 ${meta.sha256['ro/main'].slice(0, 12)}...)`);
    log(`  ${henTargetRel.padEnd(13)} : ${fs.statSync(path.join(outDir, henTargetRel)).size} B (sha256 ${meta.sha256[henTargetRel].slice(0, 12)}...)`);
    log(`  bootstrap.bin : ${fs.statSync(path.join(outDir, 'bootstrap.bin')).size} B (sha256 ${meta.sha256['bootstrap.bin'].slice(0, 12)}...)`);
    log('');
    log('DONE! Patched kaiHEN ready for Launch kaiHEN:');
    log(`  ${outDir}`);
    return outDir;
  } finally {
    try { fs.rmSync(tmpRoot, {recursive: true, force: true}); } catch {}
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--patch-json' && args[1]) {
    patchAndBuildKaihen(JSON.parse(args[1])).catch(err => {
      console.error('ERROR:', err.message || err);
      process.exit(1);
    });
  } else {
    console.log('Usage: node kaihen-win.cjs --patch-json <json>');
  }
}

module.exports = {
  KAIHEN_TAG,
  DEFAULT_PATCHED_DIR,
  DEFAULT_NS2JB_DIR,
  DEFAULT_DOCKER_IMAGE,
  detectDocker,
  detectWslNode,
  toWslPath,
  inspectKaihenDir,
  listLanIps,
  findNs2jbDir,
  ensureNs2jb,
  patchAndBuildKaihen,
};
