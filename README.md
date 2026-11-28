# KaiVesper Prep

**Windows Native `.nup`, Unencrypted `ExeFS / RomFS` & `kaiHEN` Patch/Launch Tool** — by **sank-kab**

> [!CAUTION]
> ### Anti-Piracy & Legal Disclaimer
> **KaiVesper Prep does NOT support, facilitate, or condone software piracy.**
> - This project contains **zero** Nintendo proprietary code, encryption keys, firmware, signed binaries, or copyrighted game assets.
> - KaiVesper Prep **only** operates on **unencrypted** packages/directories (`.nup`, `exefs/`, `romfs/`, `romfs.bin`) and open-source homebrew (`kaiHEN`, `ns2jb`). It does **not** decrypt `.nsp`, `.xci`, `.nca`, or DRM-protected files and includes **no** key-derivation or DRM-bypass functionality.
> - Use this tool strictly with **homebrew or legally obtained unencrypted backups of software you personally own**.
> - "Nintendo" and "Nintendo Switch" are registered trademarks of Nintendo Co., Ltd. This project is an independent open-source effort and is not affiliated with or endorsed by Nintendo.

> [!WARNING]
> ### Console Safety, Data Loss & No-Warranty Disclaimer
> **USE ENTIRELY AT YOUR OWN RISK.**
> - Preparing modified game profiles and running homebrew (`kaiHEN`) on a Nintendo Switch 2 carries inherent risks, including **application crashes, save-data corruption, microSD filesystem errors, account/console bans if used online, or potential console instability/bricking**.
> - Always back up your microSD card and important save data before writing files or launching homebrew on your console.
> - This software is provided **"AS IS"**, without warranty of any kind, express or implied, under the GPL-2.0 license. The author (`sank-kab`) assumes **zero liability** for any damage, bricking, ban, or data loss.

---

## Overview

**KaiVesper Prep** is a lightweight Windows companion app for **[KaiVesper](https://github.com/Sank-kab/KaiVesper)** (`kaivesper.nro`):
- **Zero WSL required** for `.nup` extraction and `ExeFS / RomFS` installation (WSL2 is only used by **`Launch kaiHEN`**)
- **Zero `npm install` / zero external Node dependencies**
- **1-Click Patched `kaiHEN` Builder & WSL2-based Launcher** built right in
- **Zero Host setup on PC** — profiles are automatically placed into `/ns2jb-modloader/sw2/` or `/sw1/` on your MicroSD with `main.npdm` cleanly skipped, so you choose your Host title directly on Switch 2 inside **KaiVesper → Hosts**!

---

## Features

1. **Tab 1 — Extract `.nup` to MicroSD (`ExeFS + RomFS`):**
   - Automatically detects **Switch 2 (`04...`)** vs **Switch 1 (`01...`)** packages from Title ID.
   - Extracts clean unencrypted `NSO0` executables into `exefs/` (skipping `main.npdm` while exporting only its 128-byte unsigned `META` header to `exefs/meta.bin` so KaiVesper automatically merges `SystemResourceSize` and `MainThreadStackSize` into any Host's signed `main.npdm`).
   - **Universal SDK Auto-Patcher (`exefs_patches/<sdkBuildId>.ips32`):**
     - **`FinishStartupLogo` micro-patch:** automatically detects games that never call `nn::oe::FinishStartupLogo()` and injects a PAC-safe tail-call so startup logos dismiss cleanly even on `Manual Logo` Hosts.
     - **`MountTemporaryStorage -> RamDisk` trampoline:** automatically redirects `nn::fs::MountTemporaryStorage` to a userland `nn::fs::MountRamDisk` buffer (16 MiB, with 4 MiB / `malloc` fallbacks — zero FS IPC, zero NACP `TemporaryStorageSize` required) so temporary saves work on any Host.
   - Merges Base + Update RomFS and packs a ready-to-load `romfs.bin` directly onto your MicroSD (`<SD>:\ns2jb-modloader\sw2\<name>\` or `sw1\<name>\`).
2. **Tab 2 — Install Unencrypted `ExeFS + RomFS` (`Switch 1` & `Switch 2` → MicroSD):**
   - Supports **both Switch 2 (`/sw2/`) and Switch 1 (`/sw1/`)** already-extracted unencrypted `exefs/` + `romfs/` (or `romfs.bin`) folders.
   - **Quick-Pick Auto-Detect:** select a parent game folder to auto-fill `exefs/`, `romfs/` (or `romfs.bin`), `exefs_patches/`, `sw1`/`sw2` generation, and profile name.
   - Exports `exefs/meta.bin`, applies the same universal SDK auto-patches (`FinishStartupLogo` + `MountTemporaryStorage -> RamDisk`), and optionally packs loose `romfs/` into `romfs.bin` on PC for instant loading on Switch 2.
3. **1-Click `Patch Existing SD Games` (available in Tab 1 & Tab 2):**
   - Scans every game profile already on `<SD>:\ns2jb-modloader\` (`sw2/`, `sw1/`, `contents/`) and applies or updates `FinishStartupLogo`, `MountTemporaryStorage -> RamDisk`, and `exefs/meta.bin` **in place** — without re-extracting or re-copying multi-gigabyte `romfs.bin` images!
4. **Tab 3 — `kaiHEN (Patch & Launch)`:**
   - **1-Click `Patch & Build kaiHEN`:** automatically downloads `ouncebrew/kaihen` (`20261117.1`) and the 3 public `ro:dmnt` FS helper patches from `nicholasyoannou/switch2-modbridge` (`kaihen/patches/*.patch`), compiles `ro/main`, `hen/main`, and `bootstrap.bin` inside Docker (`ounce-devkit:latest`, auto-built on first run if missing), and assembles a ready-to-launch patched kaiHEN folder (`%USERPROFILE%\.kaivesper-prep\kaiHEN-20261117.1-kaivesper-patched` by default).
   - **1-Click `Launch kaiHEN` (via WSL2):** automatically downloads `ns2jb` (`hen.cjs` / `run.cjs`) on first launch and runs it cleanly via **WSL2 + Node.js** (required because `ns2jb` uses Linux Unix domain sockets `.sock`), with a **PC LAN IP selector**, live **SmileBASIC Direct-mode `V=START(...)` command banner** (+ Copy button), interactive **stdin** input, and an automatic **`kaiHEN Active!`** status indicator.
5. **6-Language Interface (English default):**
   - English, Italiano, Español, Français, Deutsch, 日本語 (persisted in browser storage).
6. **Native Windows Ergonomics:**
   - Native Windows file/folder pickers, automatic MicroSD drive detection, 1-click native Windows `nup` installer (isolated Python venv in `%USERPROFILE%\.kaivesper-prep\nup-venv`), stale-server auto-restart, and safe process-tree cancellation (`taskkill /T /F`).

---

## Prerequisites (Windows 10 / 11)

1. **Node.js 18 or newer (LTS)** — https://nodejs.org
2. **Python 3.9 or newer** — https://www.python.org/downloads/ *(required for `.nup` extraction and PC-side `romfs.bin` packing; check **"Add python.exe to PATH"** during installation)*
3. **WSL2 + Node.js inside WSL** *(only required for **`Launch kaiHEN`**)*
4. **Docker** *(only required if you use **`Patch & Build kaiHEN`**; NOT required for `.nup`, `ExeFS + RomFS`, or **`Launch kaiHEN`**)* — either **Docker Desktop for Windows** (https://www.docker.com/products/docker-desktop/) or Docker running inside WSL2.

> **Note:** An **exFAT-formatted microSD card** is required for games whose `romfs.bin` exceeds 4 GiB.

---

## Quick Start

1. Download or clone this repository and double-click **`Launch KaiVesper Prep.vbs`** (or `launch.bat`).
   - The app starts a local server on `http://127.0.0.1:47822` and opens in a clean app window (Microsoft Edge app mode, or your default browser).
2. **Patch & Launch `kaiHEN` (Tab 3 — `kaiHEN (Patch & Launch)`):**
   - Click **`Patch & Build kaiHEN`** (leave both folder fields blank to auto-download official `kaiHEN-20261117.1.zip` and output to the default folder).
   - Once finished, the patched folder is auto-filled below! Select your **PC LAN IP**, open **SmileBASIC** in Direct mode on your Switch 2, click **`Launch kaiHEN`**, and enter the highlighted `V=START(...)` command on Switch 2.
3. **Prepare Games (Tab 1 or Tab 2):**
   - **Extract `.nup`:** *(first time only)* click **`1-Click Install nup`** in the top bar (~30s), then pick a `.nup` file, confirm the profile name and MicroSD drive, and click **`Extract & Place on SD`**.
   - **ExeFS + RomFS (SW1 / SW2):** choose **Switch 2** or **Switch 1**, click **`Pick Folder...`** on your unencrypted game folder (or pick `exefs/` and `romfs/` individually), and click **`Install ExeFS + RomFS to SD`**.
4. Safely eject your MicroSD card, insert it into your Switch 2, open **KaiVesper** in hbmenu, pick your Host in the **Hosts** tab (**`Auto Logo (Best)`** recommended), and load your game from **Games**!

---

## Troubleshooting

- **"Node.js 18+ is required" popup on launch:** Install Node.js LTS from https://nodejs.org, then reopen `Launch KaiVesper Prep.vbs`.
- **"Python missing" pill in top bar:** Install Python 3.9+ from https://www.python.org/downloads/ (checking *Add to PATH*). For Mode 2 (`ExeFS + RomFS`), you can also uncheck *"Pack loose `romfs/` into `romfs.bin` on PC"* to copy `romfs/` directly and let KaiVesper pack it on-console.
- **"Docker missing" pill in the `kaiHEN` tab:** Install and start Docker Desktop (or start Docker in WSL2) before clicking **`Patch & Build kaiHEN`**. If you already have a patched kaiHEN folder, **`Launch kaiHEN`** works without Docker.
- **`Launch kaiHEN` needs WSL2 + Node.js inside WSL** (ns2jb uses Linux Unix sockets, unsupported by Node on Windows). Install with `wsl --install`, then Node.js 18+ in your distro. If the Switch 2 cannot reach the PC, enable WSL *mirrored networking* (`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`, then `wsl --shutdown`).
- **Switch 2 cannot connect during `Launch kaiHEN`:** Ensure your Switch 2 and PC are on the same local Wi-Fi/LAN, select your real LAN IP (e.g. `192.168.x.x`) in the **PC LAN IP** dropdown (not a virtual WSL/VPN adapter), and allow Node.js on Private networks in Windows Firewall if prompted.
- **Cancelling a running job:** Click **`Cancel`** or **`Stop kaiHEN`** — KaiVesper Prep terminates the entire process tree cleanly.

---

## Credits & Third-Party Software

- Bundles **[`a55uka/nup`](https://github.com/a55uka/nup)** (MIT) for unencrypted `.nup` extraction (with `zstandard` installed on demand in an isolated Python venv).
- Bundles a WebAssembly ZBIC decoder (`lib/zbic.wasm`) built with **Zstandard (`zstd`, BSD-3-Clause / GPL-2.0)** and **WASI libc (MIT / Apache-2.0)**.
- Downloads & patches **[`ouncebrew/kaihen`](https://github.com/ouncebrew/kaihen)** (GPL-2.0) using **[`ouncebrew/ounce-devkit`](https://github.com/ouncebrew/ounce-devkit)** and the public `ro:dmnt` FS helper patches from **[`nicholasyoannou/switch2-modbridge`](https://github.com/nicholasyoannou/switch2-modbridge)**.
- Launches patched `kaiHEN` (through WSL2) using **[`kurumuz/ns2jb`](https://gitlab.com/kurumuz/ns2jb)** (`hen.cjs` / `run.cjs`).

## License

Licensed under the **GNU General Public License v2.0 only (`GPL-2.0-only`)**. See [LICENSE](LICENSE) for full terms.
