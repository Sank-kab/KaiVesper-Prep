'use strict';
const $ = id => document.getElementById(id);

const savedLang = localStorage.getItem('kvp_lang');
let lang = (savedLang && window.KVP_I18N[savedLang]) ? savedLang : 'en';
let logs = [];
let lastOutput = null;
let lastEnv = null;
let lastJobState = {status: 'idle', lastOutput: null};
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
  renderLogs();
}

$('lang-select').addEventListener('change', e => {
  lang = e.target.value;
  localStorage.setItem('kvp_lang', lang);
  applyLanguage();
});

function switchMode(mode) {
  const isNup = mode === 'nup';
  $('tab-btn-nup').classList.toggle('active', isNup);
  $('tab-btn-sw1').classList.toggle('active', !isNup);
  $('panel-nup').classList.toggle('hidden', !isNup);
  $('panel-sw1').classList.toggle('hidden', isNup);
}
$('tab-btn-nup').addEventListener('click', () => switchMode('nup'));
$('tab-btn-sw1').addEventListener('click', () => switchMode('sw1'));

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

function renderJobState(st) {
  lastJobState = st || {status: 'idle'};
  const running = lastJobState.status === 'running';
  $('btn-start').disabled = running;
  $('btn-sw1-start').disabled = running;
  $('btn-stop').classList.toggle('hidden', !running);
  $('btn-sw1-stop').classList.toggle('hidden', !running);
  lastOutput = lastJobState.lastOutput || null;
  $('btn-open-out').classList.toggle('hidden', !lastOutput || running);
  $('btn-sw1-open-out').classList.toggle('hidden', !lastOutput || running);
  const pill = $('pill-job');
  pill.className = 'pill';
  if (running) { pill.textContent = t('pillRunning'); pill.classList.add('cyan'); }
  else if (lastJobState.status === 'done') { pill.textContent = t('pillDone'); pill.classList.add('ok'); }
  else if (lastJobState.status === 'error') { pill.textContent = t('pillErr'); pill.classList.add('err'); }
  else { pill.textContent = t('pillReady'); }
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

function renderEnv(env) {
  lastEnv = env;
  const py = $('pill-py');
  py.textContent = env.python.ok ? env.python.version : t('pyMissing');
  py.className = 'pill ' + (env.python.ok ? 'ok' : 'err');

  const nup = $('pill-nup');
  nup.textContent = env.nup.ok ? t('nupOk') : t('nupMissing');
  nup.className = 'pill ' + (env.nup.ok ? 'ok' : 'warn');
  $('btn-install-nup').classList.toggle('hidden', env.nup.ok || !env.python.ok);

  const drives = env.drives && env.drives.length ? env.drives : [{letter: 'D', hasModloader: false}];
  populateDriveSelect($('sd-drive'), drives);
  populateDriveSelect($('sw1-sd-drive'), drives);
}

async function refreshEnv() {
  const env = await api('/api/env');
  renderEnv(env);
  if (env.job) {
    logs = env.job.logs || [];
    renderLogs();
    renderJobState(env.job);
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

/* Mode 2 (Switch 1) browse handlers */
$('btn-browse-sw1-parent').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select Switch 1 game folder containing exefs/ and romfs/'})});
    if (!res.path) return;
    $('sw1-parent').value = res.path;
    const info = await api('/api/sw1/inspect', {method: 'POST', body: JSON.stringify({path: res.path})});
    if (info.exefsPath) $('sw1-exefs').value = info.exefsPath;
    if (info.romfsPath) $('sw1-romfs').value = info.romfsPath;
    if (info.suggestedName && !$('sw1-name').value.trim()) $('sw1-name').value = info.suggestedName;
    sw1PatchesDir = info.patchesDir || null;
    toast(t('toastSw1Detected'));
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-sw1-exefs').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select unencrypted Switch 1 exefs/ folder'})});
    if (res.path) $('sw1-exefs').value = res.path;
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-sw1-romfs-dir').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select unencrypted Switch 1 romfs/ folder'})});
    if (res.path) $('sw1-romfs').value = res.path;
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-sw1-romfs-file').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/file', {method: 'POST', body: JSON.stringify({kind: 'romfs'})});
    if (res.path) $('sw1-romfs').value = res.path;
  } catch (e) { toast(e.message, true); }
});

$('btn-browse-sw1-out').addEventListener('click', async () => {
  try {
    const res = await api('/api/dialog/folder', {method: 'POST', body: JSON.stringify({description: 'Select output folder'})});
    if (res.path) $('sw1-out-dir').value = res.path;
  } catch (e) { toast(e.message, true); }
});

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

const stopJob = () => api('/api/prepare/stop', {method: 'POST'}).catch(e => toast(e.message, true));
const openOut = () => { if (lastOutput) api('/api/open-folder', {method: 'POST', body: JSON.stringify({path: lastOutput})}); };
$('btn-stop').addEventListener('click', stopJob);
$('btn-sw1-stop').addEventListener('click', stopJob);
$('btn-open-out').addEventListener('click', openOut);
$('btn-sw1-open-out').addEventListener('click', openOut);
$('btn-clear-log').addEventListener('click', () => { logs = []; renderLogs(); });
$('btn-quit').addEventListener('click', async () => {
  await api('/api/shutdown', {method: 'POST'}).catch(() => {});
  toast(t('toastStopped'));
  setTimeout(() => window.close(), 500);
});

const ev = new EventSource('/api/events');
ev.addEventListener('state', e => renderJobState(JSON.parse(e.data)));
ev.addEventListener('log', e => { logs.push(JSON.parse(e.data)); if (logs.length > 500) logs.shift(); renderLogs(); });

applyLanguage();
refreshEnv().catch(e => toast(e.message, true));
