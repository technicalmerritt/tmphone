# TM Phone

Standalone iPhone / iPad diagnostics for the repair bench, by Technical Merritt
Computer Services. A lean Electron app that reads a connected iOS/iPadOS device
over USB and shows:

- **Identity** — model, serial, IMEI/IMEI2, MEID, UDID, phone number, ICCID,
  Wi-Fi/Bluetooth MAC, region, approximate manufacture year.
- **Battery health** — capacity %, cycle count, design vs full-charge capacity,
  with a Good / Fair / Replace verdict.
- **Storage** — used / free with a low-space warning.
- **Software** — iOS/iPadOS version and build, security-currency hint.
- **Ownership** — Find My / Activation Lock status (critical before any erase or
  resale), honest about what can't be read over USB.
- **Findings + health score** — a plain-English, severity-ranked summary.

Read-only — nothing is changed on the device.

## How it reads devices

It drives the open-source **libimobiledevice** command-line tools over USB. Those
binaries are **not** bundled or auto-downloaded (supply-chain safety). Instead:

1. Install Apple's Mobile Device driver (via **iTunes** or the free **Apple
   Devices** app from the Microsoft Store) — this provides the USB service.
2. In the app, use **Install from file…** to point at a vetted copy of the
   libimobiledevice Windows tools (a `.zip` containing `ideviceinfo.exe`,
   `idevice_id.exe`, `idevicediagnostics.exe` and their DLLs). They are saved
   next to the app (portable, so they travel on a USB stick).
3. Connect a device, unlock it, tap **Trust**, then **Read device**.

## Run from source (development)

```bash
npm install
npm start
```

## Build a portable Windows app

```bash
npm run dist
```

## Project layout

```
src/main/main.js             Electron main process, window + IPC
src/main/preload.js          contextBridge API
src/main/idevice/idevice.js  Tool runner (resolves tools from a portable folder)
src/main/idevice/idevice-parse.js  Pure, unit-tested parse + analysis engine
src/renderer/                UI (index.html, idevice-ui.js, styles.css)
```

The parse/analysis engine (`idevice-parse.js`) has no I/O and is covered by unit
tests, so the diagnostic logic can be verified without a device present.

## Status

Phase 1 (device identity + health readout) complete. Phase 2 — one-click
registration of a phone as a Syncro asset — is planned next.
