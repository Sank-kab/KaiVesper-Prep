# KaiVesper Prep

**Windows Native `.nup` & Unencrypted `ExeFS / RomFS` MicroSD Preparation Tool (Zero WSL)** — by **sank-kab**

> [!CAUTION]
> ### Anti-Piracy & Legal Disclaimer
> **KaiVesper Prep does NOT support, facilitate, or condone software piracy.**
> - This project contains **zero** Nintendo proprietary code, encryption keys, firmware, signed binaries, or copyrighted game assets.
> - KaiVesper Prep **only** operates on **unencrypted** packages/directories (`.nup`, `exefs/`, `romfs/`, `romfs.bin`). It does **not** decrypt `.nsp`, `.xci`, `.nca`, or DRM-protected files and includes **no** key-derivation or DRM-bypass functionality.
> - Use this tool strictly with **homebrew or legally obtained unencrypted backups of software you personally own**.
> - "Nintendo" and "Nintendo Switch" are registered trademarks of Nintendo Co., Ltd. This project is an independent open-source effort and is not affiliated with or endorsed by Nintendo.

> [!WARNING]
> ### Console Safety, Data Loss & No-Warranty Disclaimer
> **USE ENTIRELY AT YOUR OWN RISK.**
> - Preparing modified game profiles and running homebrew on a Nintendo Switch 2 carries inherent risks, including **application crashes, save-data corruption, microSD filesystem errors, account/console bans if used online, or potential console instability/bricking**.
> - Always back up your microSD card and important save data before writing files or launching homebrew on your console.
> - This software is provided **"AS IS"**, without warranty of any kind, express or implied, under the GPL-2.0 license. The author (`sank-kab`) assumes **zero liability** for any damage, bricking, ban, or data loss.

---

## Overview

**KaiVesper Prep** is a lightweight, **100% native Windows** companion app for **[KaiVesper](https://github.com/Sank-kab/KaiVesper)** (`kaivesper.nro`):
- **Zero WSL required**
- **Zero `npm install` / zero external Node dependencies**
- **Zero Host setup on PC** — profiles are automatically placed into `/ns2jb-modloader/sw2/` or `/ns2jb-modloader/sw1/` on your MicroSD with `main.npdm` cleanly skipped, so you choose your Host title directly on Switch 2 inside **KaiVesper → Hosts**!

---

## Features

1. **Tab 1 — Extract `.nup` to MicroSD (`ExeFS + RomFS`):**
   - Automatically detects **Switch 2 (`04...`)** vs **Switch 1 (`01...`)** packages from Title ID.
   - Extracts clean unencrypted `NSO0` executables into `exefs/` (automatically skipping `main.npdm`).
   - Automatically detects and generates the 23-byte `MountTemporaryStorage` `.ips32` patch in `exefs_patches/` when needed (supports both Switch 2 ZBIC and Switch 1 LZ4 NSOs via bundled WebAssembly ZBIC decoder).
   - Merges Base + Update RomFS and packs a ready-to-load `romfs.bin` directly onto your MicroSD (`<SD>:\ns2jb-modloader\sw2\<name>\` or `sw1\<name>\`).
2. **Tab 2 — Install Unencrypted `ExeFS + RomFS` (`Switch 1` & `Switch 2` → MicroSD):**
   - Supports **both Switch 2 (`/sw2/`) and Switch 1 (`/sw1/`)** already-extracted unencrypted `exefs/` + `romfs/` (or `romfs.bin`) folders.
   - **Quick-Pick Auto-Detect:** select a parent game folder to auto-fill `exefs/`, `romfs/` (or `romfs.bin`), `exefs_patches/`, and profile name.
   - Automatically skips `main.npdm`, inspects NPDM architecture (`64-bit` vs `32-bit` & `SystemResourceSize`), auto-patches `MountTemporaryStorage` if needed, and optionally packs loose `romfs/` into `romfs.bin` on PC for instant loading on Switch 2.
3. **6-Language Interface (English default):**
   - English, Italiano, Español, Français, Deutsch, 日本語 (persisted in browser storage).
4. **Native Windows Ergonomics:**
   - Native Windows file/folder pickers, automatic MicroSD drive detection, 1-click native Windows `nup` installer (isolated Python venv in `%USERPROFILE%\.kaivesper-prep\nup-venv`), and safe process-tree cancellation (`taskkill /T /F`).

---

## Prerequisites (Windows 10 / 11)

1. **Node.js 18 or newer (LTS)** — https://nodejs.org
2. **Python 3.9 or newer** — https://www.python.org/downloads/
   *(Recommended: check **"Add python.exe to PATH"** during installation; both `python` and the `py -3` launcher are supported.)*

> **Note:** An **exFAT-formatted microSD card** is required for games whose `romfs.bin` exceeds 4 GiB.

---

## Quick Start

1. Download or clone this repository and double-click **`Launch KaiVesper Prep.vbs`** (or `launch.bat`).
   - The app starts a local server on `http://127.0.0.1:47822` and opens in a clean app window (Microsoft Edge app mode, or your default browser).
2. *(Only needed for `.nup` extraction)* Click **`1-Click Install nup`** in the top bar (one-time ~30-second native Windows install).
3. Choose either:
   - **Extract `.nup`:** pick a `.nup` file, confirm the profile name and MicroSD drive, and click **`Extract & Place on SD`**.
   - **ExeFS + RomFS (SW1 / SW2):** choose **Switch 2** or **Switch 1**, click **`Pick Folder...`** on your unencrypted game folder (or pick `exefs/` and `romfs/` individually), and click **`Install ExeFS + RomFS to SD`**.
4. Safely eject your MicroSD card, insert it into your Switch 2, open **KaiVesper** in hbmenu, pick your Host in the **Hosts** tab (**`Auto Logo (Best)`** recommended), and load your game from **Games**!

---

## Troubleshooting

- **"Node.js 18+ is required" popup on launch:** Install Node.js LTS from https://nodejs.org, then reopen `Launch KaiVesper Prep.vbs`.
- **"Python missing" pill in top bar:** Install Python 3.9+ from https://www.python.org/downloads/ (checking *Add to PATH*). For Mode 2 (`ExeFS + RomFS`), you can also uncheck *"Pack loose `romfs/` into `romfs.bin` on PC"* to copy `romfs/` directly and let KaiVesper pack it on-console.
- **`.nup` extraction fails with "`nup` not installed":** Click **`1-Click Install nup`** in the top bar and wait ~30 seconds.
- **Cancelling a running job:** Click **`Cancel`** — KaiVesper Prep terminates the entire worker tree cleanly and removes any partial output folder.

---

## Credits & Third-Party Software

- Uses **[`a55uka/nup`](https://github.com/a55uka/nup)** (MIT) for unencrypted `.nup` extraction (installed locally on demand in an isolated Python venv).
- Bundles a WebAssembly ZBIC decoder (`lib/zbic.wasm`) built with **Zstandard (`zstd`, BSD-3-Clause / GPL-2.0)** and **WASI libc (MIT / Apache-2.0)**.

## License

Licensed under the **GNU General Public License v2.0 only (`GPL-2.0-only`)**. See [LICENSE](LICENSE) for full terms.
