/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
const {execFile} = require('node:child_process');

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024},
      (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout || '').trim());
      }
    );
  });
}

async function pickFile({title = 'Select file', filter = 'NUP Package (*.nup)|*.nup|All files (*.*)|*.*'} = {}) {
  const safeTitle = title.replace(/'/g, "''");
  const safeFilter = filter.replace(/'/g, "''");
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = '${safeTitle}'
$dlg.Filter = '${safeFilter}'
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$res = $dlg.ShowDialog($owner)
$owner.Dispose()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }
`;
  const chosen = await runPowerShell(ps);
  return chosen || null;
}

async function pickFolder({description = 'Select output folder'} = {}) {
  const safeDesc = description.replace(/'/g, "''");
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '${safeDesc}'
$dlg.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$res = $dlg.ShowDialog($owner)
$owner.Dispose()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }
`;
  const chosen = await runPowerShell(ps);
  return chosen || null;
}

function openInExplorer(targetPath) {
  execFile('explorer.exe', [targetPath], {windowsHide: true}, () => {});
}

module.exports = {pickFile, pickFolder, openInExplorer};
