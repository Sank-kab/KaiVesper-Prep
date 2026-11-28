#!/usr/bin/env node
/* SPDX-License-Identifier: GPL-2.0-only */
/* KaiVesper Prep (Native Windows — ZERO WSL required!)
 * 1) Extracts .nup -> exefs/ (NSOs without main.npdm) + romfs.bin + optional MountTemporaryStorage .ips32
 *    directly into <SD>:\ns2jb-modloader\sw2\<name>\ (or sw1\<name>\ for 01... packages).
 * 2) Installs unencrypted Switch 1 exefs/ + romfs/ (or romfs.bin) directly into <SD>:\ns2jb-modloader\sw1\<name>\
 *    (optionally packing romfs/ -> romfs.bin on PC for instant loading on Switch 2).
 * Host selection is handled directly on-console inside KaiVesper's Hosts tab! */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {decodeZbic} = require('./lib/zbic.cjs');

const ROOT = __dirname;
const LIB_DIR = path.join(ROOT, 'lib');
const MERGE_ROMFS = path.join(LIB_DIR, 'merge_romfs.py');
const VENV_DIR = path.join(os.homedir(), '.kaivesper-prep', 'nup-venv');
const DEFAULT_OUT_BASE = path.join(os.homedir(), '.kaivesper-prep', 'ready');

function fail(msg) { throw new Error(msg); }
function stripQuotes(s) { return String(s || '').trim().replace(/^["']+|["']+$/g, '').trim(); }

function nupEnv() {
  return {...process.env, PYTHONPATH: LIB_DIR + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '')};
}

function resolveWindowsNup() {
  const pyExe = path.join(VENV_DIR, 'Scripts', 'python.exe');
  if (fs.existsSync(pyExe)) {
    return {pyBin: pyExe, pyArgs: [], fromVenv: true};
  }
  try {
    execFileSync('python', ['--version'], {stdio: 'ignore', windowsHide: true, timeout: 4000});
    return {pyBin: 'python', pyArgs: [], fromVenv: false};
  } catch {}
  return {pyBin: 'py', pyArgs: ['-3'], fromVenv: false};
}

function decompressLz4Block(src, expectedSize) {
  const out = Buffer.alloc(expectedSize);
  let i = 0, o = 0, n = src.length;
  while (i < n) {
    const tok = src[i++];
    let ll = tok >> 4;
    if (ll === 15) { let b = 255; while (b === 255) { b = src[i++]; ll += b; } }
    src.copy(out, o, i, i + ll); i += ll; o += ll;
    if (i >= n) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let ml = (tok & 15) + 4;
    if (ml === 19) { let b = 255; while (b === 255) { b = src[i++]; ml += b; } }
    for (let k = 0; k < ml; k++) { out[o] = out[o - off]; o++; }
  }
  return out.subarray(0, o);
}

function readNsoSegment(d, segIdx) {
  const flags = d.readUInt32LE(12);
  const foff = d.readUInt32LE(0x10 + segIdx * 16);
  const vaddr = d.readUInt32LE(0x14 + segIdx * 16);
  const usize = d.readUInt32LE(0x18 + segIdx * 16);
  const csize = d.readUInt32LE(0x60 + segIdx * 4);
  let data;
  if (flags & (1 << segIdx)) {
    if (flags & 0xc0) data = decodeZbic(d.subarray(foff, foff + csize), usize);
    else data = decompressLz4Block(d.subarray(foff, foff + csize), usize);
  } else {
    data = d.subarray(foff, foff + usize);
  }
  return {vaddr, usize, data};
}

function readNsoRodata(file) {
  const d = fs.readFileSync(file);
  if (d.length < 0x100 || d.toString('ascii', 0, 4) !== 'NSO0') fail('Invalid NSO file: ' + file);
  const buildId = d.subarray(0x40, 0x60).toString('hex');
  const dynstrOff = d.readUInt32LE(0x90), dynstrSize = d.readUInt32LE(0x94);
  const dynsymOff = d.readUInt32LE(0x98), dynsymSize = d.readUInt32LE(0x9c);
  const roSeg = readNsoSegment(d, 1);
  return {raw: d, buildId, ro: roSeg.data, dynstrOff, dynstrSize, dynsymOff, dynsymSize};
}

function findSdkSymbols(sdkInfo, wantedSet) {
  const found = new Map();
  for (let off = sdkInfo.dynsymOff; off + 24 <= sdkInfo.dynsymOff + sdkInfo.dynsymSize; off += 24) {
    const nameIdx = sdkInfo.ro.readUInt32LE(off);
    const val = Number(sdkInfo.ro.readBigUInt64LE(off + 8));
    const size = Number(sdkInfo.ro.readBigUInt64LE(off + 16));
    if (val <= 0) continue;
    const start = sdkInfo.dynstrOff + nameIdx;
    const end = sdkInfo.ro.indexOf(0, start);
    if (end < 0) continue;
    const name = sdkInfo.ro.subarray(start, end).toString('utf8');
    if (wantedSet.has(name)) {
      found.set(name, {vaddr: val, size});
      if (found.size === wantedSet.size) break;
    }
  }
  return found;
}

function encodeArm64Branch(fromVa, toVa) {
  const diff = toVa - fromVa;
  if ((diff & 3) !== 0 || Math.abs(diff) >= 0x08000000) return null;
  return (0x14000000 | (((diff / 4) & 0x03ffffff) >>> 0)) >>> 0;
}

function encodeArm64Bl(fromVa, toVa) {
  const diff = toVa - fromVa;
  if ((diff & 3) !== 0 || Math.abs(diff) >= 0x08000000) return null;
  return (0x94000000 | (((diff / 4) & 0x03ffffff) >>> 0)) >>> 0;
}

/* Finds the PLT stub VA for an imported symbol (e.g. "malloc") inside an NSO (e.g. sdk). */
function findNsoPltSymbol(rawNso, textSeg, roSeg, targetName) {
  try {
    const dataSeg = readNsoSegment(rawNso, 2);
    const segs = [textSeg, roSeg, dataSeg];
    const r32 = va => {
      for (const s of segs) if (va >= s.vaddr && va + 4 <= s.vaddr + s.data.length) return s.data.readUInt32LE(va - s.vaddr);
      return 0;
    };
    const r64 = va => {
      for (const s of segs) if (va >= s.vaddr && va + 8 <= s.vaddr + s.data.length) return Number(s.data.readBigUInt64LE(va - s.vaddr));
      return 0;
    };
    const rcs = va => {
      for (const s of segs) if (va >= s.vaddr && va < s.vaddr + s.data.length) {
        const st = va - s.vaddr, en = s.data.indexOf(0, st);
        return s.data.subarray(st, en < 0 ? st + 64 : en).toString('utf8');
      }
      return '';
    };
    const modOff = textSeg.data.readUInt32LE(4);
    const dynVa = modOff + (r32(modOff + 4) | 0);
    let strtab = 0, symtab = 0, jmprel = 0, pltrelsz = 0;
    for (let o = 0; o < 0x1000; o += 16) {
      const tag = r64(dynVa + o), val = r64(dynVa + o + 8);
      if (tag === 0) break;
      if (tag === 5) strtab = val;
      else if (tag === 6) symtab = val;
      else if (tag === 23) jmprel = val;
      else if (tag === 2) pltrelsz = val;
    }
    if (!strtab || !symtab || !jmprel || !pltrelsz) return 0;
    let targetGot = 0;
    for (let o = 0; o < pltrelsz; o += 24) {
      const rOff = r64(jmprel + o), rInfo = r64(jmprel + o + 8);
      const symIdx = Math.floor(rInfo / 0x100000000);
      if (rcs(strtab + r32(symtab + symIdx * 24)) === targetName) {
        targetGot = rOff;
        break;
      }
    }
    if (!targetGot) return 0;
    for (let o = 0; o + 16 <= textSeg.data.length; o += 4) {
      const i0 = textSeg.data.readUInt32LE(o), i1 = textSeg.data.readUInt32LE(o + 4);
      if (((i0 & 0x9f00001f) >>> 0) === 0x90000010 && ((i1 & 0xffc003ff) >>> 0) === 0xf9400211) {
        const pc = textSeg.vaddr + o;
        const immlo = (i0 >>> 29) & 3, immhi = (i0 >>> 5) & 0x7ffff;
        let imm = (immhi << 2) | immlo;
        if (imm & 0x100000) imm -= 0x200000;
        const got = (pc & ~0xfff) + imm * 4096 + ((i1 >>> 10) & 0xfff) * 8;
        if (got === targetGot) return pc;
      }
    }
  } catch {}
  return 0;
}

/* Builds a PAC-aware AArch64 trampoline inside MountTemporaryStorage(const char* name)
 * that redirects it to nn::fs::MountRamDisk(name, buf, size) using a 16 MiB (fallback 4 MiB)
 * userland RAM buffer — 0 FS IPC, 0 NACP TemporaryStorageSize required, works on EVERY Host! */
function buildTempStorageRamDiskTrampoline(tempSym, ramDiskVa, allocMemVa, mallocVa, isPac) {
  if (!tempSym || (tempSym.size && tempSym.size < 128)) return null;
  const base = tempSym.vaddr;
  const blAlloc1 = encodeArm64Bl(base + 0x24, allocMemVa);
  const blAlloc2 = encodeArm64Bl(base + 0x40, allocMemVa);
  const blMalloc = mallocVa ? encodeArm64Bl(base + 0x54, mallocVa) : 0xaa1f03e0; // mov x0, xzr if unavailable
  const blMount  = encodeArm64Bl(base + 0x68, ramDiskVa);
  if (blAlloc1 === null || blAlloc2 === null || blMalloc === null || blMount === null) return null;

  const insns = [
    isPac ? 0xd503237f : 0xd503201f, // +0x00: paciasp / nop
    0xa9bd7bfd,                      // +0x04: stp x29, x30, [sp, #-0x30]!
    0xa90153f3,                      // +0x08: stp x19, x20, [sp, #0x10]
    0x910003fd,                      // +0x0c: mov x29, sp
    0xaa0003f3,                      // +0x10: mov x19, x0              (mountName)
    0xd2a02014,                      // +0x14: movz x20, #0x100, lsl #16 (16 MiB)
    0xf90013ff,                      // +0x18: str xzr, [sp, #0x20]
    0x910083e0,                      // +0x1c: add x0, sp, #0x20        (&outAddr)
    0xaa1403e1,                      // +0x20: mov x1, x20              (16 MiB)
    blAlloc1,                        // +0x24: bl nn::os::AllocateMemoryBlock
    0x35000060,                      // +0x28: cbnz w0, +0x0c (+0x34)
    0xf94013e1,                      // +0x2c: ldr x1, [sp, #0x20]
    0xb5000181,                      // +0x30: cbnz x1, +0x30 (+0x60 do_mount)
    0xd2a00814,                      // +0x34: movz x20, #0x40, lsl #16 (4 MiB fallback)
    0x910083e0,                      // +0x38: add x0, sp, #0x20
    0xaa1403e1,                      // +0x3c: mov x1, x20
    blAlloc2,                        // +0x40: bl nn::os::AllocateMemoryBlock
    0x35000060,                      // +0x44: cbnz w0, +0x0c (+0x50)
    0xf94013e1,                      // +0x48: ldr x1, [sp, #0x20]
    0xb50000a1,                      // +0x4c: cbnz x1, +0x14 (+0x60 do_mount)
    0xaa1403e0,                      // +0x50: mov x0, x20              (4 MiB)
    blMalloc,                        // +0x54: bl PLT:malloc
    0xaa0003e1,                      // +0x58: mov x1, x0
    0xb40000a1,                      // +0x5c: cbz x1, +0x14 (+0x70 fail_ret0)
    0xaa1303e0,                      // +0x60: mov x0, x19              (do_mount: mountName)
    0xaa1403e2,                      // +0x64: mov x2, x20              (bufferSize)
    blMount,                         // +0x68: bl nn::fs::MountRamDisk
    0x14000002,                      // +0x6c: b +0x08 (+0x74 done)
    0x2a1f03e0,                      // +0x70: mov w0, wzr              (fail_ret0: return 0)
    0xa94153f3,                      // +0x74: ldp x19, x20, [sp, #0x10] (done)
    0xa8c37bfd,                      // +0x78: ldp x29, x30, [sp], #0x30
    isPac ? 0xd65f0fff : 0xd65f03c0  // +0x7c: retab / ret
  ];
  const code = Buffer.alloc(insns.length * 4);
  for (let i = 0; i < insns.length; i++) code.writeUInt32LE(insns[i] >>> 0, i * 4);
  return code;
}

function buildIps32(records) {
  const sorted = [...records].sort((a, b) => a.ipsOffset - b.ipsOffset);
  const parts = [Buffer.from('IPS32', 'ascii')];
  for (const r of sorted) {
    const hdr = Buffer.alloc(6);
    hdr.writeUInt32BE(r.ipsOffset >>> 0, 0);
    hdr.writeUInt16BE(r.code.length, 4);
    parts.push(hdr, r.code);
  }
  parts.push(Buffer.from('EEOF', 'ascii'));
  return Buffer.concat(parts);
}

/* Scans exefs/ (main, subsdk*, sdk) and generates a combined IPS32 micro-patch for sdk when needed:
 *  1) Stubs nn::fs::MountTemporaryStorage -> mov w0,#0; ret (avoids crash on Hosts without temp storage).
 *  2) Tail-calls nn::oe::FinishStartupLogo from an imported nn::oe init hook when the game itself does not
 *     call FinishStartupLogo (dismisses startup logos cleanly on Manual-Logo Hosts). */
function detectAutoSdkPatches(exefsDir) {
  const mainFile = path.join(exefsDir, 'main'), sdkFile = path.join(exefsDir, 'sdk');
  if (!fs.existsSync(mainFile) || !fs.existsSync(sdkFile)) return null;

  const mainInfo = readNsoRodata(mainFile);
  const mainStr = mainInfo.ro.toString('latin1');

  const TEMP_SYM = '_ZN2nn2fs21MountTemporaryStorageEPKc';
  const RAMDISK_SYM = '_ZN2nn2fs12MountRamDiskEPKcPvm';
  const ALLOC_MEM_SYM = '_ZN2nn2os19AllocateMemoryBlockEPmm';
  const LOGO_SYM = '_ZN2nn2oe17FinishStartupLogoEv';
  const OE_HOOK_CANDIDATES = [
    '_ZN2nn2oe42SetOperationModeChangedNotificationEnabledEb',
    '_ZN2nn2oe28SetResumeNotificationEnabledEb',
    '_ZN2nn2oe44SetPerformanceModeChangedNotificationEnabledEb',
    '_ZN2nn2oe42SetGraphicsScaleChangedNotificationEnabledEb'
  ];

  const needsTempPatch = mainStr.includes(TEMP_SYM);

  // Check if main or any subsdk already imports FinishStartupLogo
  let hasFinishLogo = mainStr.includes(LOGO_SYM);
  if (!hasFinishLogo) {
    for (const f of fs.readdirSync(exefsDir)) {
      if (!/^subsdk\d+$/i.test(f)) continue;
      try {
        const subInfo = readNsoRodata(path.join(exefsDir, f));
        if (subInfo.ro.toString('latin1').includes(LOGO_SYM)) {
          hasFinishLogo = true;
          break;
        }
      } catch {}
    }
  }
  const matchedOeHook = hasFinishLogo ? null : (OE_HOOK_CANDIDATES.find(s => mainStr.includes(s)) || null);

  if (!needsTempPatch && !matchedOeHook) return null;

  const sdkInfo = readNsoRodata(sdkFile);
  const wanted = new Set();
  if (needsTempPatch) { wanted.add(TEMP_SYM); wanted.add(RAMDISK_SYM); wanted.add(ALLOC_MEM_SYM); wanted.add('malloc'); }
  if (matchedOeHook) { wanted.add(LOGO_SYM); wanted.add(matchedOeHook); }
  const syms = findSdkSymbols(sdkInfo, wanted);
  const textSeg = readNsoSegment(sdkInfo.raw, 0);
  const roSeg = {vaddr: sdkInfo.raw.readUInt32LE(0x24), data: sdkInfo.ro};

  const records = [];
  const applied = [];

  if (needsTempPatch && syms.has(TEMP_SYM)) {
    const tempSym = syms.get(TEMP_SYM);
    const rel = tempSym.vaddr - textSeg.vaddr;
    const isPac = rel >= 0 && rel + 4 <= textSeg.data.length && textSeg.data.readUInt32LE(rel) === 0xd503237f;
    let code = null;
    if (syms.has(RAMDISK_SYM) && syms.has(ALLOC_MEM_SYM)) {
      const mallocVa = syms.has('malloc') ? syms.get('malloc').vaddr : findNsoPltSymbol(sdkInfo.raw, textSeg, roSeg, 'malloc');
      code = buildTempStorageRamDiskTrampoline(tempSym, syms.get(RAMDISK_SYM).vaddr, syms.get(ALLOC_MEM_SYM).vaddr, mallocVa, isPac);
    }
    if (code) {
      records.push({ipsOffset: tempSym.vaddr + 0x100, code});
      applied.push('MountTemporaryStorage->RamDisk');
    } else {
      const stub = Buffer.alloc(8);
      stub.writeUInt32LE(0x52800000, 0); // mov w0, #0
      stub.writeUInt32LE(0xd65f03c0, 4); // ret
      records.push({ipsOffset: tempSym.vaddr + 0x100, code: stub});
      applied.push('MountTemporaryStorage(stub)');
    }
  }

  if (matchedOeHook && syms.has(LOGO_SYM) && syms.has(matchedOeHook)) {
    const finishSym = syms.get(LOGO_SYM);
    const hookSym = syms.get(matchedOeHook);
    const relStart = hookSym.vaddr - textSeg.vaddr;
    const fnLen = hookSym.size || 0x50;
    if (relStart >= 0 && relStart + fnLen <= textSeg.data.length) {
      let retOff = -1, isPac = false;
      for (let off = 4; off + 4 <= fnLen; off += 4) {
        const insn = textSeg.data.readUInt32LE(relStart + off);
        if (insn === 0xd65f0fff) { retOff = off; isPac = true; break; }  // retab
        if (insn === 0xd65f03c0) { retOff = off; isPac = false; break; } // ret
      }
      if (retOff >= 0) {
        const retVa = hookSym.vaddr + retOff;
        if (isPac && retOff + 8 <= fnLen) {
          const bInsn = encodeArm64Branch(retVa + 4, finishSym.vaddr);
          if (bInsn !== null) {
            const code = Buffer.alloc(8);
            code.writeUInt32LE(0xd50323ff, 0); // autiasp
            code.writeUInt32LE(bInsn, 4);      // b FinishStartupLogo
            records.push({ipsOffset: retVa + 0x100, code});
            applied.push('FinishStartupLogo');
          }
        } else if (!isPac) {
          const bInsn = encodeArm64Branch(retVa, finishSym.vaddr);
          if (bInsn !== null) {
            const code = Buffer.alloc(4);
            code.writeUInt32LE(bInsn, 0);      // b FinishStartupLogo
            records.push({ipsOffset: retVa + 0x100, code});
            applied.push('FinishStartupLogo');
          }
        }
      }
    }
  }

  if (!records.length) return null;
  return {buildId: sdkInfo.buildId, applied, bytes: buildIps32(records)};
}

function detectTempStoragePatch(exefsDir) {
  return detectAutoSdkPatches(exefsDir);
}

function copyFileStream(src, dst) {
  fs.mkdirSync(path.dirname(dst), {recursive: true});
  const rfd = fs.openSync(src, 'r');
  const wfd = fs.openSync(dst, 'w');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(rfd, buf, 0, buf.length, null)) > 0) {
      fs.writeSync(wfd, buf, 0, n);
    }
  } finally {
    fs.closeSync(rfd);
    fs.closeSync(wfd);
  }
}

function copyDirRecursive(srcDir, dstDir) {
  fs.mkdirSync(dstDir, {recursive: true});
  for (const ent of fs.readdirSync(srcDir, {withFileTypes: true})) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else if (ent.isFile()) copyFileStream(s, d);
  }
}

/* Copies all valid NSO0 executables from srcExefsDir into dstExefsDir,
 * intentionally skipping main.npdm so the Host chosen inside KaiVesper on Switch 2 keeps its signed policy. */
function copyCleanExefsDir(srcExefsDir, dstExefsDir) {
  if (!fs.existsSync(srcExefsDir) || !fs.statSync(srcExefsDir).isDirectory()) {
    fail('ExeFS folder not found: ' + srcExefsDir);
  }
  const files = fs.readdirSync(srcExefsDir).filter(f => {
    if (f.toLowerCase() === 'main.npdm') return false;
    const full = path.join(srcExefsDir, f);
    return fs.statSync(full).isFile();
  });
  const nsoList = [];
  let totalBytes = 0;
  for (const name of files) {
    const full = path.join(srcExefsDir, name);
    const st = fs.statSync(full);
    if (st.size < 0x100) continue;
    const fd = fs.openSync(full, 'r');
    const magic = Buffer.alloc(4);
    try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (magic.toString('ascii') !== 'NSO0') continue;
    nsoList.push({name, full, size: st.size});
    totalBytes += st.size;
  }
  if (!nsoList.length) {
    fail('No valid unencrypted NSO0 executables found inside: ' + srcExefsDir);
  }
  fs.mkdirSync(dstExefsDir, {recursive: true});
  for (const f of nsoList) {
    copyFileStream(f.full, path.join(dstExefsDir, f.name));
  }
  // Export ONLY the 128-byte unsigned META header (SystemResourceSize / MainThreadStackSize)
  // so KaiVesper can auto-merge resource limits into any Host's signed main.npdm on console!
  const srcNpdm = path.join(srcExefsDir, 'main.npdm');
  if (fs.existsSync(srcNpdm)) {
    try {
      const fd = fs.openSync(srcNpdm, 'r');
      const meta = Buffer.alloc(128);
      const n = fs.readSync(fd, meta, 0, 128, 0);
      fs.closeSync(fd);
      if (n === 128 && meta.toString('ascii', 0, 4) === 'META') {
        fs.writeFileSync(path.join(dstExefsDir, 'meta.bin'), meta);
      }
    } catch {}
  }
  return {modules: nsoList.map(f => f.name), totalBytes};
}

function parseNupPackages(nupFile) {
  const {pyBin, pyArgs} = resolveWindowsNup();
  let info;
  try {
    info = execFileSync(pyBin, [...pyArgs, '-m', 'nup.cli', 'info', nupFile], {
      encoding: 'latin1', maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: nupEnv()
    });
  } catch (err) {
    const msg = String(err && (err.stderr || err.message) || '');
    if (msg.includes('zstandard') || (err && err.code === 'ENOENT')) {
      fail('NUP runtime (zstandard) is not installed yet! Click "1-Click Install nup" at the top.');
    }
    throw err;
  }
  const pkgs = [];
  for (const line of info.split(/\r?\n/)) {
    const m = line.match(/^\s*\[(\d+)\]\s+(\S+)\s+([0-9A-Fa-f]{16})/);
    if (m) pkgs.push({index: Number(m[1]), kind: m[2].toLowerCase(), titleId: m[3].toLowerCase()});
  }
  if (!pkgs.length) fail('No packages found inside ' + nupFile);
  return pkgs;
}

function extractBaseOnlyRomfs(nupFile, baseIdx, updateIdx, destDir) {
  const {pyBin, pyArgs} = resolveWindowsNup();
  const py = `
import sys, pathlib
from nup.read import NupReader
from nup.access import iter_children
nup_file, base_idx, upd_idx, dest = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), pathlib.Path(sys.argv[4])
dest.mkdir(parents=True, exist_ok=True)
def walk_romfs(r, dir_idx, prefix=""):
    out = {}
    if dir_idx == 0xFFFFFFFF:
        return out
    for node in iter_children(r, dir_idx):
        name = node.name.decode("utf-8")
        rel = f"{prefix}/{name}" if prefix else name
        if node.is_dir:
            out.update(walk_romfs(r, node.index, rel))
        else:
            out[rel] = node.index
    return out
with NupReader(nup_file) as r:
    upd_files = walk_romfs(r, r.packages[upd_idx].romfs_dir)
    base_files = walk_romfs(r, r.packages[base_idx].romfs_dir)
    base_only = [(rel, fi) for rel, fi in base_files.items() if rel not in upd_files]
    print(f'Base-only files to merge: {len(base_only)}', flush=True)
    for rel, fi in base_only:
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        _, off, size, _, _ = r.files[fi]
        with out.open('wb') as f:
            pos = 0
            while pos < size:
                chunk = min(4 * 1024 * 1024, size - pos)
                f.write(r._mm[off + pos:off + pos + chunk])
                pos += chunk
`;
  execFileSync(pyBin, [...pyArgs, '-c', py, nupFile, String(baseIdx), String(updateIdx), destDir], {
    stdio: 'inherit', windowsHide: true, env: nupEnv()
  });
}

function resolveDestination({gameName, genFolder, outDir, sdDrive}) {
  if (outDir && outDir.trim()) {
    return path.join(path.resolve(outDir.trim()), gameName);
  }
  if (sdDrive && /^[A-Za-z]/.test(sdDrive.trim())) {
    const letter = sdDrive.trim()[0].toUpperCase();
    return path.join(`${letter}:\\`, 'ns2jb-modloader', genFolder, gameName);
  }
  return path.join(DEFAULT_OUT_BASE, genFolder, gameName);
}

/* Mode 1: Extract .nup -> exefs/ + romfs.bin + optional .ips32 patch
 * Automatically placed in <SD>:\ns2jb-modloader\sw2\<gameName>\ (or sw1\<gameName>\ for 01... packages). */
function prepareNup({nupPath, gameName, outDir = null, sdDrive = null, autoPatch = true}) {
  const {pyBin, pyArgs} = resolveWindowsNup();
  nupPath = stripQuotes(nupPath);
  outDir = stripQuotes(outDir);
  if (!nupPath || !gameName) fail('Specify both a .nup file and a profile name.');
  if (!/^[A-Za-z0-9._-]+$/.test(gameName)) fail('Profile name may only contain letters, digits, dots, hyphens, and underscores.');
  const nupFile = path.resolve(nupPath);
  if (!fs.existsSync(nupFile)) fail('NUP file not found: ' + nupFile);

  const pkgs = parseNupPackages(nupFile);
  const basePkg = pkgs.find(p => p.kind === 'base') || pkgs[0];
  const updatePkg = pkgs.find(p => p.kind === 'update') || null;
  const codePkg = updatePkg || basePkg;
  const isSw1 = codePkg.titleId.startsWith('01');
  const genFolder = isSw1 ? 'sw1' : 'sw2';

  const finalOut = resolveDestination({gameName, genFolder, outDir, sdDrive});
  if (fs.existsSync(finalOut)) fail('Destination folder already exists: ' + finalOut);

  console.log(`Detected package type: ${isSw1 ? 'Switch 1 (01...)' : 'Switch 2 (04...)'}`);
  console.log(`NUP packages found:    ${pkgs.map(p => `[${p.index}] ${p.kind} (${p.titleId})`).join(', ')}`);
  console.log(`Destination:           ${finalOut}`);
  console.log('(Host title will be chosen directly on-console in KaiVesper -> Hosts tab)');

  const tmpBase = path.join(os.homedir(), '.kaivesper-prep', 'tmp');
  fs.mkdirSync(tmpBase, {recursive: true});
  const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'prep-'));

  try {
    // 1) Extract ExeFS
    const exefsTmp = path.join(tmpDir, 'exefs-extract');
    console.log(`\n[1/3] Extracting ExeFS from package [${codePkg.index}] ${codePkg.kind}...`);
    execFileSync(pyBin, [...pyArgs, '-m', 'nup.cli', 'extract', '--package', String(codePkg.index), '--subtree', 'exefs', nupFile, exefsTmp], {
      stdio: 'inherit', windowsHide: true, env: nupEnv()
    });
    const exefsSrc = fs.existsSync(path.join(exefsTmp, 'main')) ? exefsTmp : path.join(exefsTmp, 'exefs');

    // 2) Copy clean ExeFS NSOs (skipping main.npdm so ANY Host chosen on console works!) + auto-patch
    fs.mkdirSync(finalOut, {recursive: true});
    console.log('\n[2/3] Copying clean ExeFS modules (main.npdm skipped for universal Host support)...');
    const exefsOut = path.join(finalOut, 'exefs');
    const copied = copyCleanExefsDir(exefsSrc, exefsOut);
    console.log(`      Modules copied: ${copied.modules.join(', ')} (${(copied.totalBytes / 1024 / 1024).toFixed(1)} MB)`);

    if (autoPatch) {
      const patch = detectAutoSdkPatches(exefsSrc);
      if (patch) {
        const patchDir = path.join(finalOut, 'exefs_patches');
        fs.mkdirSync(patchDir, {recursive: true});
        fs.writeFileSync(path.join(patchDir, patch.buildId + '.ips32'), patch.bytes);
        console.log(`      [AUTO-PATCH] Applied ${patch.applied.join(' + ')}: exefs_patches/${patch.buildId}.ips32`);
      } else {
        console.log('      No SDK auto-patches needed (FinishStartupLogo present, no MountTemporaryStorage).');
      }
    }

    // 3) Extract & build romfs.bin
    console.log('\n[3/3] Extracting and building romfs.bin (this may take a few minutes)...');
    const mainRomfsTmp = path.join(tmpDir, 'romfs-main');
    const baseOnlyTmp = path.join(tmpDir, 'romfs-base-only');
    fs.mkdirSync(baseOnlyTmp, {recursive: true});
    execFileSync(pyBin, [...pyArgs, '-m', 'nup.cli', 'extract', '--package', String(codePkg.index), '--subtree', 'romfs', nupFile, mainRomfsTmp], {
      stdio: 'inherit', windowsHide: true, env: nupEnv()
    });
    const mainRomfsDir = fs.existsSync(path.join(mainRomfsTmp, 'romfs')) ? path.join(mainRomfsTmp, 'romfs') : mainRomfsTmp;
    if (updatePkg && basePkg && updatePkg.index !== basePkg.index) {
      console.log('      Base + Update detected: merging base-only files...');
      extractBaseOnlyRomfs(nupFile, basePkg.index, updatePkg.index, baseOnlyTmp);
    }
    const romfsOut = path.join(finalOut, 'romfs.bin');
    execFileSync(pyBin, [...pyArgs, MERGE_ROMFS, '--exact-update', '--update', mainRomfsDir, '--base-only', baseOnlyTmp, '--image', romfsOut, 'build'], {stdio: 'inherit', windowsHide: true});

    const romSize = fs.statSync(romfsOut).size;
    console.log(`\nREADY! Profile installed to:\n  ${finalOut}`);
    console.log(`  exefs/: ${(copied.totalBytes / 1024 / 1024).toFixed(1)} MB (${copied.modules.length} NSO)  |  romfs.bin: ${(romSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
    return finalOut;
  } catch (err) {
    try { fs.rmSync(finalOut, {recursive: true, force: true}); } catch {}
    throw err;
  } finally {
    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch {}
  }
}

/* Auto-detects Switch 1 (sw1) vs Switch 2 (sw2) from exefs/main.npdm (ACI0 Program ID)
 * or fallback to exefs/main NSO0 compression flags (ZBIC = sw2, LZ4 = sw1). */
function detectExefsGen(exefsDir) {
  if (!exefsDir || !fs.existsSync(exefsDir)) return {gen: null, titleId: null, source: null};
  const npdmPath = path.join(exefsDir, 'main.npdm');
  if (fs.existsSync(npdmPath)) {
    try {
      const npdm = fs.readFileSync(npdmPath);
      if (npdm.length >= 0x78 && npdm.toString('ascii', 0, 4) === 'META') {
        const aci0Off = npdm.readUInt32LE(0x70);
        if (aci0Off + 0x18 <= npdm.length && npdm.toString('ascii', aci0Off, aci0Off + 4) === 'ACI0') {
          const tid = npdm.readBigUInt64LE(aci0Off + 0x10).toString(16).padStart(16, '0');
          if (tid.startsWith('01')) return {gen: 'sw1', titleId: tid, source: 'npdm'};
          if (tid.startsWith('04')) return {gen: 'sw2', titleId: tid, source: 'npdm'};
        }
      }
    } catch {}
  }
  const mainPath = path.join(exefsDir, 'main');
  if (fs.existsSync(mainPath)) {
    try {
      const fd = fs.openSync(mainPath, 'r');
      const hdr = Buffer.alloc(0x10);
      try { fs.readSync(fd, hdr, 0, 0x10, 0); } finally { fs.closeSync(fd); }
      if (hdr.toString('ascii', 0, 4) === 'NSO0') {
        const flags = hdr.readUInt32LE(0x0c);
        if (flags & 0x40) return {gen: 'sw2', titleId: null, source: 'nso-zbic'};
        if (flags & 0x07) return {gen: 'sw1', titleId: null, source: 'nso-lz4'};
      }
    } catch {}
  }
  return {gen: null, titleId: null, source: null};
}

/* Inspects an unencrypted game folder to auto-detect exefs/, romfs/ or romfs.bin, exefs_patches/, and SW1/SW2 gen. */
function inspectSw1Folder(folderPath) {
  const dir = path.resolve(stripQuotes(folderPath));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail('Folder not found: ' + dir);
  }
  const findChild = (names, wantDir) => {
    const entries = fs.readdirSync(dir, {withFileTypes: true});
    for (const target of names) {
      const hit = entries.find(e => e.name.toLowerCase() === target && (wantDir ? e.isDirectory() : e.isFile()));
      if (hit) return path.join(dir, hit.name);
    }
    return null;
  };
  let exefsPath = findChild(['exefs'], true);
  if (!exefsPath && fs.existsSync(path.join(dir, 'main'))) exefsPath = dir;
  const romfsBin = findChild(['romfs.bin'], false);
  const romfsDir = findChild(['romfs'], true);
  const patchesDir = findChild(['exefs_patches'], true);
  const det = detectExefsGen(exefsPath);
  return {
    folder: dir,
    suggestedName: path.basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''),
    exefsPath,
    romfsPath: romfsBin || romfsDir || null,
    romfsIsFile: Boolean(romfsBin),
    patchesDir,
    detectedGen: det.gen,
    detectedTitleId: det.titleId,
    detectedSource: det.source
  };
}

/* Mode 2: Install unencrypted Switch 1 or Switch 2 exefs/ + romfs/ (or romfs.bin)
 * directly to <SD>:\ns2jb-modloader\sw1\<gameName>\ or <SD>:\ns2jb-modloader\sw2\<gameName>\ */
function prepareSw1({exefsPath = null, romfsPath = null, patchesDir = null, gameName, targetGen = 'sw1', outDir = null, sdDrive = null, packRomfs = true}) {
  const {pyBin, pyArgs} = resolveWindowsNup();
  exefsPath = stripQuotes(exefsPath);
  romfsPath = stripQuotes(romfsPath);
  patchesDir = stripQuotes(patchesDir);
  outDir = stripQuotes(outDir);
  const genFolder = (String(targetGen || 'sw1').toLowerCase() === 'sw2') ? 'sw2' : 'sw1';
  const genLabel = genFolder === 'sw2' ? 'Switch 2' : 'Switch 1';

  if (!gameName) fail('Enter a profile folder name.');
  if (!/^[A-Za-z0-9._-]+$/.test(gameName)) fail('Profile name may only contain letters, digits, dots, hyphens, and underscores.');
  if (!exefsPath && !romfsPath) fail('Select at least an exefs/ folder or a romfs/ folder (or romfs.bin).');

  const finalOut = resolveDestination({gameName, genFolder, outDir, sdDrive});
  if (fs.existsSync(finalOut)) fail('Destination folder already exists: ' + finalOut);

  console.log(`${genLabel} Unencrypted Installer -> ${finalOut}`);
  console.log(`(Choose your ${genLabel} Host directly inside KaiVesper -> Hosts tab on Switch 2!)`);

  const tmpBase = path.join(os.homedir(), '.kaivesper-prep', 'tmp');
  fs.mkdirSync(tmpBase, {recursive: true});
  const emptyBase = fs.mkdtempSync(path.join(tmpBase, 'raw-empty-'));

  try {
    fs.mkdirSync(finalOut, {recursive: true});

    if (exefsPath) {
      const resolvedExe = path.resolve(exefsPath);
      console.log(`\n[1/2] Copying unencrypted ${genLabel} ExeFS from ${resolvedExe}...`);
      let is64Bit = true;
      const srcNpdm = path.join(resolvedExe, 'main.npdm');
      if (fs.existsSync(srcNpdm)) {
        try {
          const npdm = fs.readFileSync(srcNpdm);
          if (npdm.length >= 0x30 && npdm.toString('ascii', 0, 4) === 'META') {
            const flags = npdm[0x0c];
            is64Bit = Boolean(flags & 1);
            const sysResMb = (npdm.readUInt32LE(0x2c) / (1024 * 1024)).toFixed(0);
            console.log(`      Target NPDM info: ${is64Bit ? '64-bit (AArch64)' : '32-bit (ARM32!)'} | SystemResourceSize: ${sysResMb} MB`);
            if (!is64Bit && genFolder === 'sw1') {
              console.log('      [NOTE] This Switch 1 game is 32-bit! Select a 32-bit Switch 1 Host on console.');
            }
          }
        } catch {}
      }
      const copied = copyCleanExefsDir(resolvedExe, path.join(finalOut, 'exefs'));
      console.log(`      Modules copied: ${copied.modules.join(', ')} (${(copied.totalBytes / 1024 / 1024).toFixed(1)} MB) — main.npdm skipped cleanly.`);

      if (is64Bit) {
        try {
          const patch = detectAutoSdkPatches(resolvedExe);
          if (patch) {
            const patchDir = path.join(finalOut, 'exefs_patches');
            fs.mkdirSync(patchDir, {recursive: true});
            fs.writeFileSync(path.join(patchDir, patch.buildId + '.ips32'), patch.bytes);
            console.log(`      [AUTO-PATCH] Applied ${patch.applied.join(' + ')}: exefs_patches/${patch.buildId}.ips32`);
          }
        } catch (e) {
          console.log('      [WARN] Skipped SDK auto-patch check: ' + e.message);
        }
      }
    } else {
      console.log('\n[1/2] No exefs/ folder specified (RomFS-only install).');
    }

    if (patchesDir && fs.existsSync(path.resolve(patchesDir))) {
      console.log('      Copying exefs_patches/...');
      copyDirRecursive(path.resolve(patchesDir), path.join(finalOut, 'exefs_patches'));
    }

    if (romfsPath) {
      const resolvedRom = path.resolve(romfsPath);
      if (!fs.existsSync(resolvedRom)) fail('RomFS path not found: ' + resolvedRom);
      const st = fs.statSync(resolvedRom);
      if (st.isFile()) {
        console.log(`\n[2/2] Copying romfs.bin (${(st.size / 1024 / 1024 / 1024).toFixed(2)} GB) to SD...`);
        copyFileStream(resolvedRom, path.join(finalOut, 'romfs.bin'));
      } else if (st.isDirectory()) {
        if (packRomfs) {
          console.log('\n[2/2] Packing loose romfs/ into romfs.bin directly on PC (fast load on Switch 2)...');
          const romfsOut = path.join(finalOut, 'romfs.bin');
          try {
            execFileSync(pyBin, [...pyArgs, MERGE_ROMFS, '--exact-update', '--update', resolvedRom, '--base-only', emptyBase, '--image', romfsOut, 'build'], {stdio: 'inherit', windowsHide: true});
          } catch (err) {
            if (err && err.code === 'ENOENT') {
              fail('Python 3.9+ is required to pack romfs/ on PC (install Python from python.org, or uncheck "Pack romfs/ on PC" to let KaiVesper pack it on Switch 2).');
            }
            throw err;
          }
          const romSize = fs.statSync(romfsOut).size;
          console.log(`      Built romfs.bin (${(romSize / 1024 / 1024 / 1024).toFixed(2)} GB)`);
        } else {
          console.log('\n[2/2] Copying loose romfs/ folder to SD (KaiVesper will auto-pack on first launch if needed)...');
          copyDirRecursive(resolvedRom, path.join(finalOut, 'romfs'));
        }
      }
    } else {
      console.log('\n[2/2] No romfs/ specified (ExeFS-only install).');
    }

    console.log(`\nREADY! ${genLabel} profile installed to:\n  ${finalOut}`);
    return finalOut;
  } catch (err) {
    try { fs.rmSync(finalOut, {recursive: true, force: true}); } catch {}
    throw err;
  } finally {
    try { fs.rmSync(emptyBase, {recursive: true, force: true}); } catch {}
  }
}

/* Mode 3: Scan all existing games already on MicroSD (/ns2jb-modloader/sw1, /sw2, /contents/.../games)
 * and apply universal compatibility patches (FinishStartupLogo, MountTemporaryStorage->RamDisk, meta.bin)
 * in-place without re-extracting or re-copying romfs.bin! */
function patchExistingSdGames({sdDrive = null}) {
  const letter = String(sdDrive || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!letter) fail('Select a MicroSD drive letter first.');
  const baseRoot = `${letter}:\\ns2jb-modloader`;
  if (!fs.existsSync(baseRoot)) fail(`Folder not found on MicroSD: ${baseRoot}`);

  const targets = [];
  for (const gen of ['sw2', 'sw1']) {
    const dir = path.join(baseRoot, gen);
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
      if (ent.isDirectory() && !ent.name.startsWith('.')) {
        targets.push({label: `${gen}/${ent.name}`, dir: path.join(dir, ent.name), gen});
      }
    }
  }
  const contentsDir = path.join(baseRoot, 'contents');
  if (fs.existsSync(contentsDir)) {
    for (const tidEnt of fs.readdirSync(contentsDir, {withFileTypes: true})) {
      if (!tidEnt.isDirectory() || !/^0[14][0-9a-f]{14}$/i.test(tidEnt.name)) continue;
      const gen = tidEnt.name.startsWith('01') ? 'sw1' : 'sw2';
      const gamesDir = path.join(contentsDir, tidEnt.name, 'games');
      if (!fs.existsSync(gamesDir)) continue;
      for (const ent of fs.readdirSync(gamesDir, {withFileTypes: true})) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) {
          targets.push({label: `contents/${tidEnt.name}/${ent.name}`, dir: path.join(gamesDir, ent.name), gen});
        }
      }
    }
  }

  if (!targets.length) {
    console.log(`No game profiles found inside ${baseRoot}.`);
    return baseRoot;
  }

  console.log(`Scanning ${targets.length} existing profile(s) on ${baseRoot}...\n`);
  let updated = 0;

  for (const item of targets) {
    const exefsDir = path.join(item.dir, 'exefs');
    const hasExefsDir = fs.existsSync(exefsDir) && fs.statSync(exefsDir).isDirectory();
    const hasExefsNsp = fs.existsSync(path.join(item.dir, 'exefs.nsp'));

    if (!hasExefsDir) {
      if (hasExefsNsp) {
        console.log(`[SKIP] ${item.label}: uses legacy exefs.nsp (re-prepare or unpack to exefs/ for universal Host support)`);
      } else {
        console.log(`[SKIP] ${item.label}: RomFS-only profile (no exefs/ folder)`);
      }
      continue;
    }

    let changed = false;
    try {
      const patch = detectAutoSdkPatches(exefsDir);
      if (patch) {
        const patchDir = path.join(item.dir, 'exefs_patches');
        fs.mkdirSync(patchDir, {recursive: true});
        const outFile = path.join(patchDir, patch.buildId + '.ips32');
        const prev = fs.existsSync(outFile) ? fs.readFileSync(outFile) : null;
        if (!prev || !prev.equals(patch.bytes)) {
          fs.writeFileSync(outFile, patch.bytes);
          console.log(`[PATCHED] ${item.label}: exefs_patches/${patch.buildId}.ips32 (${patch.applied.join(' + ')})`);
          changed = true;
        } else {
          console.log(`[OK]      ${item.label}: SDK patch already up to date (${patch.applied.join(' + ')})`);
        }
      } else {
        console.log(`[OK]      ${item.label}: no SDK IPS patch needed`);
      }
    } catch (e) {
      console.log(`[WARN]    ${item.label}: skipped SDK patch check (${e.message})`);
    }

    const metaPath = path.join(exefsDir, 'meta.bin');
    if (!fs.existsSync(metaPath)) {
      const npdmPath = path.join(exefsDir, 'main.npdm');
      if (fs.existsSync(npdmPath)) {
        try {
          const fd = fs.openSync(npdmPath, 'r');
          const meta = Buffer.alloc(128);
          const n = fs.readSync(fd, meta, 0, 128, 0);
          fs.closeSync(fd);
          if (n === 128 && meta.toString('ascii', 0, 4) === 'META') {
            fs.writeFileSync(metaPath, meta);
            console.log(`[META]    ${item.label}: exported exefs/meta.bin from main.npdm`);
            changed = true;
          }
        } catch {}
      } else if (item.gen === 'sw2') {
        const meta = Buffer.alloc(128);
        meta.write('META', 0, 'ascii');
        meta.writeUInt32LE(0x3000000, 0x14); // 48 MB SystemResourceSize floor
        meta.writeUInt32LE(0x200000, 0x1c);  // 2 MB MainThreadStackSize floor
        fs.writeFileSync(metaPath, meta);
        console.log(`[META]    ${item.label}: created exefs/meta.bin (48 MB SystemResourceSize / 2 MB Stack)`);
        changed = true;
      }
    }

    if (changed) updated++;
  }

  console.log(`\nDONE! Scanned ${targets.length} profile(s) on ${baseRoot} — updated ${updated}.`);
  return baseRoot;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--prepare-json') {
      prepareNup(JSON.parse(args[1]));
    } else if (args[0] === '--prepare-sw1-json') {
      prepareSw1(JSON.parse(args[1]));
    } else if (args[0] === '--patch-sd-json') {
      patchExistingSdGames(JSON.parse(args[1]));
    } else {
      console.log('Usage: node prepare-win.cjs --prepare-json \'{"nupPath":"...","gameName":"..."}\'');
      console.log('   or: node prepare-win.cjs --prepare-sw1-json \'{"exefsPath":"...","romfsPath":"...","gameName":"..."}\'');
      console.log('   or: node prepare-win.cjs --patch-sd-json \'{"sdDrive":"D"}\'');
    }
  } catch (err) {
    console.error('ERROR: ' + (err.message || err));
    process.exit(1);
  }
}

module.exports = {resolveWindowsNup, nupEnv, prepareNup, prepareSw1, patchExistingSdGames, inspectSw1Folder, detectAutoSdkPatches, VENV_DIR, DEFAULT_OUT_BASE};
