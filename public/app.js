'use strict';
const $ = id => document.getElementById(id);

const savedLang = localStorage.getItem('kvp_lang');
let lang = (savedLang && window.KVP_I18N[savedLang]) ? savedLang : 'en';
let logs = [];
let khLogs = [];
let lastOutput = null;
let lastEnv = null;
let lastJobState = {status: 'idle', kind: null, lastOutput: null};
let lastKaihenState = {status: 'idle', ready: false, smileBasicCmd: null};
let lastKaihenDirInfo = null;
let sw1PatchesDir = null;

function t(key, vars = {}) {
  const dict = window.KVP_I18N[lang] || window.KVP_I18N.en;
  let str = dict[key] !== undefined ? dict[key] : (window.KVP_I18N.en[key] || key);
  for (const [k, v] of Object.entries(vars)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
}

function applyLanguage() {
  document.documentElement.lang = lang;
  $('lang-select').value = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  if (lastEnv) renderEnv(lastEnv);
  renderJobState(lastJobState);
  renderKaihenState(lastKaihenState);
  renderKaihenDirBadge(lastKaihenDirInfo);
  renderLogs();
  renderKhLogs();
}

$('lang-select').addEventListener('change', e => {
  lang = e.target.value;
  localStorage.setItem('kvp_lang', lang);
  applyLanguage();
});

function switchMode(mode) {
  for (const m of ['nup', 'sw1', 'kaihen']) {
    const active = m === mode;
    $(`tab-btn-${m}`).classList.toggle('active', active);
    $(`panel-${m}`).classList.toggle('hidden', !active);
  }
}
$('tab-btn-nup').addEventListener('click', () => switchMode('nup'));
$('tab-btn-sw1').addEventListener('click', () => switchMode('sw1'));
$('tab-btn-kaihen').addEventListener('click', () => switchMode('kaihen'));

function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4200);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {headers: {'Content-Type': 'application/json'}, ...opts});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderLogs() {
  const el = $('log-view');
  el.textContent = logs.length ? logs.map(l => `[${l.ts}] ${l.line}`).join('\n') : t('logEmpty');
  el.scrollTop = el.scrollHeight;
}

function renderKhLogs() {
  const el = $('kh-log-view');
  el.textContent = khLogs.length ? khLogs.map(l => `[${l.ts}] ${l.line}`).join('\n') : t('khLogEmpty');
  el.scrollTop = el.scrollHeight;
}

function renderKaihenDirBadge(info) {
  lastKaihenDirInfo = info;
  const badge = $('kh-dir-badge');
  if (!info || !$('kh-launch-dir').value.trim()) {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden', 'ok', 'warn', 'err');
  if (info.valid && info.patched) {
    badge.textContent = t('khBadgePatched');
    badge.classList.add('ok');
  } else if (info.valid) {
    badge.textContent = t('khBadgeStock');
    badge.classList.add('warn');
  } else {
    badge.textContent = t('khBadgeInvalid');
    badge.classList.add('err');
  }
}

async function inspectKaihenLaunchDir() {
  const p = $('kh-launch-dir').value.trim();
  if (!p) return renderKaihenDirBadge(null);
  try {
    const info = await api('/api/kaihen/inspect', {method: 'POST', body: JSON.stringify({path: p})});
    renderKaihenDirBadge(info);
  } catch {}
}

function renderJobState(st) {
  const prevStatus = lastJobState.status;
  lastJobState = st || {status: 'idle'};
  const running = lastJobState.status === 'running';
  $('btn-start').disabled = running;
  $('btn-sw1-start').disabled = running;
  $('btn-patch-sd').disabled = running;
  $('btn-sw1-patch-sd').disabled = running;
  $('btn-kh-patch').disabled = running;
  $('btn-stop').classList.toggle('hidden', !running);
  $('btn-sw1-stop').classList.toggle('hidden', !running);
  $('btn-kh-patch-stop').classList.toggle('hidden', !running);
  lastOutput = lastJobState.lastOutput || null;
  $('btn-open-out').classList.toggle('hidden', !lastOutput || running);
  $('btn-sw1-open-out').classList.toggle('hidden', !lastOutput || running);
  $('btn-kh-open-out').classList.toggle('hidden', !lastOutput || running || lastJobState.kind !== 'kaihen-patch');

  const pill = $('pill-job');
  pill.className = 'pill';
  if (running) { pill.textContent = t('pillRunning'); pill.classList.add('cyan'); }
  else if (lastJobState.status === 'done') { pill.textContent = t('pillDone'); pill.classList.add('ok'); }
  else if (lastJobState.status === 'error') { pill.textContent = t('pillErr'); pill.classList.add('err'); }
  else { pill.textContent = t('pillReady'); }

  if (prevStatus === 'running' && lastJobState.status === 'done' && lastJobState.kind === 'kaihen-patch' && lastOutput) {
    $('kh-launch-dir').value = lastOutput;
    inspectKaihenLaunchDir();
    toast(t('toastKhPatchDone'));
  }
}

function renderKaihenState(st) {
  lastKaihenState = st || {status: 'idle', ready: false, smileBasicCmd: null};
  const running = lastKaihenState.status === 'running';
  $('btn-kh-launch').disabled = running;
  $('btn-kh-stop').classList.toggle('hidden', !running);
  $('btn-kh-send').disabled = !running;

  const pill = $('pill-kh-run');
  pill.className = 'pill';
  if (lastKaihenState.ready) {
    pill.textContent = t('khActive');
    pill.classList.add('ok');
  } else if (running) {
    pill.textContent = t('khRunning');
    pill.classList.add('cyan');
  } else if (lastKaihenState.status === 'error') {
    pill.textContent = t('pillErr');
    pill.classList.add('err');
  } else {
    pill.textContent = t('khIdle');
  }

  const cmd = lastKaihenState.smileBasicCmd;
  $('kh-cmd-banner').classList.toggle('hidden', !cmd);
  if (cmd) $('kh-cmd-code').textContent = cmd;
  $('kh-ready-banner').classList.toggle('hidden', !lastKaihenState.ready);
}

function populateDriveSelect(sel, drives) {
  const prev = sel.value;
  sel.innerHTML = '';
  for (const d of drives) {
    const opt = document.createElement('option');
    opt.value = d.letter;
    opt.textContent = `${d.letter}:` + (d.hasModloader ? t('sdTag') : '');
    if (prev ? d.letter === prev : d.hasModloader) opt.selected = true;
    sel.appendChild(opt);
  }
}

function populateIpSelect(sel, ips) {
  const prev = sel.value;
  sel.innerHTML = '';
  if (!ips || !ips.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(Auto)';
    sel.appendChild(opt);
    return;
  }
  ips.forEach((item, idx) => {
    const opt = document.createElement('option');
    opt.value = item.ip;
    opt.textContent = `${item.ip} (${item.iface})`;
    if (prev ? item.ip === prev : idx === 0) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderEnv(env) {
  lastEnv = env;
  const py = $('pill-py');
  py.textContent = env.python.ok ? env.python.version : t('pyMissing');
  py.className = 'pill ' + (env.python.ok ? 'ok' : 'err');

  const nup = $('pill-nup');
  nup.textContent = env.nup.ok ? t('nupOk') : t('nupMissing');
  nup.className = 'pill ' + (env.nup.ok ? 'ok' : 'warn');
  $('btn-install-nup').classList.toggle('hidden', env.nup.ok || !env.python.ok);

  const dk = $('pill-docker');
  if (env.docker && env.docker.ok) {
    dk.textContent = t('dockerOk', {mode: env.docker.mode});
    dk.className = 'pill ok';
  } else {
    dk.textContent = t('dockerMissing');
    dk.className = 'pill warn';
  }

  const drives = env.drives && env.drives.length ? env.drives : [{letter: 'D', hasModloader: false}];
  populateDriveSelect($('sd-drive'), drives);
  populateDriveSelect($('sw1-sd-drive'), drives);
  populateIpSelect($('kh-ip'), env.lanIps || []);

  if (!$('kh-launch-dir').value.trim() && env.defaultPatchedKaihen && env.defaultPatchedKaihen.valid) {
    $('kh-launch-dir').value = env.defaultPatchedKaihen.path;
    renderKaihenDirBadge(env.defaultPatchedKaihen);
  }
}

async function refreshEnv() {
  const env = await api('/api/env');
  renderEnv(env);
  if (env.job) {
    logs = env.job.logs || [];
    renderLogs();
    renderJobState(env.job);
  }
  if (env.kaihen) {
    khLogs = env.kaihen.logs || [];
    renderKhLogs();
    renderKaihenState(env.kaihen);
  }
}

$('dest-mode').addEventListener('change', () => {
  const isSd = $('dest-mode').value === 'sd';
  $('sd-field').classList.toggle('hidden', !isSd);
  $('custom-out-field').classList.toggle('hidden', isSd);
});

$('sw1-dest-mode').addEventListener('change', () => {
  const isSd = $('sw1-dest-mode').value === 'sd';
  $('sw1-sd-field').classList.toggle('hidden', !isSd);
  $('sw1-custom-out-field').classList.toggle('hidden', isSd);
});

/* Mode 1 browse handlers */
$('btn-browse-nup').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/file', {method: 'POST', body: JSON.stringify({kind: 'nup'})});
    if (res.path) {
      $('nup-path').value = res.path;
      if (!$('game-name').value.trim()) {
        const stem = res.path.split(/[\\/]/).pop().replace(/\.nup$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
        $('game-name').value = stem;
      }
    }
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-out').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select output folder'})});
    if (res.path) $('out-dir').value = res.path;
  } catch (e) { toast(e.message, true); }
});

/* Mode 2 (ExeFS + RomFS) browse handlers */
$('btn-browse-sw1-parent').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select game folder containing exefs/ and romfs/'})});
    if (!res.path) return;
    $('sw1-parent').value = res.path;
    const info = await api('/api/sw1/inspect', {method: 'POST', body: JSON.stringify({path: res.path})});
    $('sw1-exefs').value = info.exefsPath || '';
    $('sw1-romfs').value = info.romfsPath || '';
    $('sw1-name').value = info.suggestedName || '';
    if (info.detectedGen) $('sw1-gen').value = info.detectedGen;
    sw1PatchesDir = info.patchesDir || null;
    toast(t('toastSw1Detected') + (info.detectedGen ? ` (${info.detectedGen.toUpperCase()})` : ''));
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-sw1-exefs').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select unencrypted exefs/ folder'})});
    if (res.path) {
      $('sw1-exefs').value = res.path;
      sw1PatchesDir = null;
      const info = await api('/api/sw1/inspect', {method: 'POST', body: JSON.stringify({path: res.path})}).catch(() => null);
      if (info && info.detectedGen) $('sw1-gen').value = info.detectedGen;
    }
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-sw1-romfs-dir').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select unencrypted romfs/ folder'})});
    if (res.path) {
      $('sw1-romfs').value = res.path;
      sw1PatchesDir = null;
    }
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-sw1-romfs-file').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/file', {method: 'POST', body: JSON.stringify({kind: 'romfs'})});
    if (res.path) {
      $('sw1-romfs').value = res.path;
      sw1PatchesDir = null;
    }
  } catch (e) { toast(e.message, true); }
});

$('sw1-exefs').addEventListener('input', () => { sw1PatchesDir = null; });
$('sw1-romfs').addEventListener('input', () => { sw1PatchesDir = null; });

$('btn-browse-sw1-out').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select output folder'})});
    if (res.path) $('sw1-out-dir').value = res.path;
  } catch (e) { toast(e.message, true); }
});

/* Mode 3 (kaiHEN) browse & action handlers */
$('btn-browse-kh-stock').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select stock kaiHEN folder (optional)'})});
    if (res.path) $('kh-stock-dir').value = res.path;
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-kh-out').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select output folder for patched kaiHEN'})});
    if (res.path) $('kh-out-dir').value = res.path;
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-kh-launch').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select patched kaiHEN folder to launch'})});
    if (res.path) {
      $('kh-launch-dir').value = res.path;
      inspectKaihenLaunchDir();
    }
  } catch (e) { toast(e.message, true); }
});

$('kh-launch-dir').addEventListener('change', inspectKaihenLaunchDir);

$('btn-kh-patch').addEventListener('click', async () => {
  try {
    logs = [];
    lastOutput = null;
    renderLogs();
    await api('/api/kaihen/patch', {
      method: 'POST',
      body: JSON.stringify({
        stockDir: $('kh-stock-dir').value.trim() || null,
        outDir: $('kh-out-dir').value.trim() || null
      })
    });
    toast(t('toastKhPatchStarted'));
  } catch (e) { toast(e.message, true); }
});

$('btn-kh-launch').addEventListener('click', async () => {
  const kaihenDir = $('kh-launch-dir').value.trim();
  if (!kaihenDir) return toast(t('toastKhMissingDir'), true);
  try {
    khLogs = [];
    renderKhLogs();
    await api('/api/kaihen/start', {
      method: 'POST',
      body: JSON.stringify({
        kaihenDir,
        ip: $('kh-ip').value || null
      })
    });
    toast(t('toastKhLaunchStarted'));
  } catch (e) { toast(e.message, true); }
});

$('btn-kh-stop').addEventListener('click', () => {
  api('/api/kaihen/stop', {method: 'POST'}).catch(e => toast(e.message, true));
});

const sendKhStdin = async () => {
  const text = $('kh-stdin').value;
  try {
    await api('/api/kaihen/stdin', {method: 'POST', body: JSON.stringify({text})});
    $('kh-stdin').value = '';
  } catch (e) { toast(e.message, true); }
};
$('btn-kh-send').addEventListener('click', sendKhStdin);
$('kh-stdin').addEventListener('keydown', e => { if (e.key === 'Enter') sendKhStdin(); });

$('btn-kh-copy').addEventListener('click', async () => {
  const txt = $('kh-cmd-code').textContent;
  if (!txt) return;
  try {
    await navigator.clipboard.writeText(txt);
    toast(t('toastCopied'));
  } catch { toast(txt); }
});
$('btn-kh-clear').addEventListener('click', () => { khLogs = []; renderKhLogs(); });

$('btn-install-nup').addEventListener('click', async () => {
  try {
    $('btn-install-nup').disabled = true;
    toast(t('toastInstallingNup'));
    await api('/api/install-nup', {method: 'POST', body: '{}'});
    toast(t('toastNupDone'));
    await refreshEnv();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('btn-install-nup').disabled = false;
  }
});

$('btn-start').addEventListener('click', async () => {
  const nupPath = $('nup-path').value.trim();
  const gameName = $('game-name').value.trim();
  if (!nupPath || !gameName) return toast(t('toastMissingFields'), true);
  const isSd = $('dest-mode').value === 'sd';
  try {
    logs = [];
    lastOutput = null;
    renderLogs();
    await api('/api/prepare/start', {
      method: 'POST',
      body: JSON.stringify({
        nupPath,
        gameName,
        sdDrive: isSd ? $('sd-drive').value : null,
        outDir: isSd ? null : $('out-dir').value.trim(),
        autoPatch: $('auto-patch').checked
      })
    });
    toast(t('toastStarted'));
  } catch (e) { toast(e.message, true); }
});

$('btn-sw1-start').addEventListener('click', async () => {
  const exefsPath = $('sw1-exefs').value.trim();
  const romfsPath = $('sw1-romfs').value.trim();
  const gameName = $('sw1-name').value.trim();
  if ((!exefsPath && !romfsPath) || !gameName) return toast(t('toastSw1Missing'), true);
  const isSd = $('sw1-dest-mode').value === 'sd';
  try {
    logs = [];
    lastOutput = null;
    renderLogs();
    await api('/api/sw1/start', {
      method: 'POST',
      body: JSON.stringify({
        exefsPath: exefsPath || null,
        romfsPath: romfsPath || null,
        patchesDir: sw1PatchesDir,
        gameName,
        targetGen: $('sw1-gen').value,
        sdDrive: isSd ? $('sw1-sd-drive').value : null,
        outDir: isSd ? null : $('sw1-out-dir').value.trim(),
        packRomfs: $('sw1-pack-romfs').checked
      })
    });
    toast(t('toastStarted'));
  } catch (e) { toast(e.message, true); }
});

const runPatchSd = async (selectId) => {
  const sdDrive = $(selectId).value;
  if (!sdDrive) return toast(t('toastNoSdDrive'), true);
  try {
    logs = [];
    lastOutput = null;
    renderLogs();
    await api('/api/patch-sd', {method: 'POST', body: JSON.stringify({sdDrive})});
    toast(t('toastPatchSdStarted'));
  } catch (e) { toast(e.message, true); }
};
$('btn-patch-sd').addEventListener('click', () => runPatchSd('sd-drive'));
$('btn-sw1-patch-sd').addEventListener('click', () => runPatchSd('sw1-sd-drive'));

const stopJob = () => api('/api/prepare/stop', {method: 'POST'}).catch(e => toast(e.message, true));
const openOut = () => { if (lastOutput) api('/api/open-folder', {method: 'POST', body: JSON.stringify({path: lastOutput})}); };
$('btn-stop').addEventListener('click', stopJob);
$('btn-sw1-stop').addEventListener('click', stopJob);
$('btn-kh-patch-stop').addEventListener('click', stopJob);
$('btn-open-out').addEventListener('click', openOut);
$('btn-sw1-open-out').addEventListener('click', openOut);
$('btn-kh-open-out').addEventListener('click', openOut);
$('btn-clear-log').addEventListener('click', () => { logs = []; renderLogs(); });
$('btn-quit').addEventListener('click', async () => {
  await api('/api/shutdown', {method: 'POST'}).catch(() => {});
  toast(t('toastStopped'));
  setTimeout(() => window.close(), 500);
});

const ev = new EventSource('/api/events');
ev.addEventListener('state', e => renderJobState(JSON.parse(e.data)));
ev.addEventListener('log', e => { logs.push(JSON.parse(e.data)); if (logs.length > 500) logs.shift(); renderLogs(); });
ev.addEventListener('kaihen-state', e => renderKaihenState(JSON.parse(e.data)));
ev.addEventListener('kaihen-log', e => { khLogs.push(JSON.parse(e.data)); if (khLogs.length > 500) khLogs.shift(); renderKhLogs(); });

applyLanguage();
refreshEnv().catch(e => toast(e.message, true));
