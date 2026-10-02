# Local Remote

[中文](README.zh-CN.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

An open-source, mobile-first remote control for macOS and Windows on a trusted local network. View and control your computer from Safari, Chrome, or another modern browser—nothing needs to be installed on the phone.

> Local Remote is intentionally LAN-only. It has no TLS or account system. Never expose its port to the public internet.

## Why Local Remote?

- **Phone-first control:** trackpad and direct-touch modes, drag, right-click, inertial scrolling, pinch-to-zoom, landscape view, and fullscreen.
- **Useful keyboard support:** Chinese and other IME text, modifier keys, navigation keys, long text, and platform-specific shortcuts.
- **Low-latency native capture:** ScreenCaptureKit/CGEvent on macOS; Windows desktop capture and SendInput on Windows.
- **Zero-install client:** scan the terminal QR code and use the browser already on your phone.
- **Local and transparent:** no cloud relay, analytics, account, or third-party runtime service.
- **Managed startup:** per-user launchd on macOS or an interactive scheduled task on Windows, with login startup and crash recovery.

## Requirements

- macOS 13+ or Windows 10/11
- Node.js 20 or newer
- A phone or computer on the same trusted LAN
- macOS: Screen Recording and Accessibility permissions
- Windows: .NET Framework 4.x with its C# compiler, Windows PowerShell 5.1+, and a signed-in, unlocked desktop

## Quick start on macOS

```bash
git clone https://github.com/ahtcfg24/local-remote.git
cd local-remote
./start.sh
```

The script installs dependencies, builds the native helpers, starts a launchd user service, and prints access URLs. Scan the QR code shown in the log or open a printed URL such as:

```text
http://192.168.1.8:8787/#token=<generated-secret>
```

The random 256-bit token persists in `.run/token` with owner-only permissions. New links use a fragment so the credential is not sent in the initial page request; legacy `?token=` links still work. After loading, the browser keeps it in session storage and removes it from the visible address bar. Use **Copy link**, or **Share** in the mobile view tools, to share access. When opened through loopback, the app prefers an available LAN address for sharing.

You can also open the host address and paste a complete access link or key. Invalid keys show a recovery form, and interrupted connections retry automatically. Permission, capture, and control states are visible; input is blocked until a current frame is available. **Pause control** temporarily switches to viewing.

### macOS permissions

Local Remote needs:

- **Screen Recording** to capture the main display.
- **Accessibility** to inject mouse and keyboard events.

Select **Permission guide** in the web app or run:

```bash
./remote.sh guide
```

Grant both permissions to **Local Remote Agent**. launchd starts that app as the top-level service process, which then supervises Node and the control worker, so the guide, status checks, and actual input injection share one TCC responsible identity. A running agent detects Accessibility changes automatically. After granting Screen Recording, restart the service if capture does not begin automatically.

Local source builds use ad-hoc signing by default, so macOS may ask again after the Swift agent is changed and rebuilt. If you have a persistent Apple code-signing identity, set `LOCAL_REMOTE_CODESIGN_IDENTITY` while building so permission grants continue to match agent updates:

```bash
LOCAL_REMOTE_CODESIGN_IDENTITY="Apple Development: ..." npm run build:native
```

If both switches are enabled but the restarted service still reports no permission, macOS may retain a requirement for the previous signature. Toggling the switches did not replace that stale record in our live test. After completing the build, reset only this app's two decisions, then authorize the current app again:

```bash
./start.sh stop
tccutil reset Accessibility com.local-remote.agent
tccutil reset ScreenCapture com.local-remote.agent
./start.sh
```

This removes only this app's two permission decisions. Enable **Local Remote Agent** in Accessibility and Screen & System Audio Recording afterward; do not rebuild again after granting access. See [Apple's permission-reset documentation](https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos).

## Windows setup

Clone or copy this repository to a folder owned by the desktop user. In an elevated Windows PowerShell window, run:

```powershell
cd C:\Users\you\local_remote
Copy-Item .env.example .env
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 start -InstallFirewall
```

The launcher installs npm dependencies, builds `.build/local-remote-agent.exe`, and registers a task for the signed-in desktop user. The task runs with **Limited** privileges by default in the user's interactive session, starts at login, and supervises Node with crash retry. It stores no Windows password. `-InstallFirewall` requires elevation and creates one inbound TCP rule for the configured Node executable and port, **Private/Domain** network profiles, and **LocalSubnet** peers. It leaves the network category unchanged. On a Public network, switch your trusted LAN to Private through Windows settings before enabling LAN access.

For a fixed address, reserve the Windows machine's address in your router, or configure a persistent static IPv4 address with the correct subnet, gateway, and DNS. Set `HOST` in `.env` to that assigned address and keep `PORT=8787`. For example, a machine assigned `192.168.1.10/24` can use:

```dotenv
HOST=192.168.1.10
PORT=8787
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 restart -InstallFirewall -FirewallRemoteAddress 192.168.1.0/24
```

This also restricts the firewall's local address to `HOST`. The launcher does not change DHCP, routing, DNS, or Windows sign-in settings. The generated 256-bit token stays fixed in `.run/token`; the installed task's effective token is saved in `.run/windows-service-token`. `.run` and `.env` have Windows access control lists restricted to the service user and SYSTEM. Changing `.env` requires `restart`; `start` leaves a healthy running task in place.

```powershell
.\start.ps1              # install/start; keep a healthy existing instance
.\start.ps1 status       # show URLs; check HTTP, token, and native agent
.\start.ps1 restart      # apply code/config changes and rebuild as needed
.\start.ps1 stop         # stop now; keep login startup and token
.\start.ps1 logs         # follow .run/local-remote.log
.\start.ps1 doctor       # inspect task, desktop, addresses, and firewall
.\start.ps1 uninstall    # elevated if removing the firewall rule; keep token/logs
```

For applications running as administrator, you can explicitly select the task's **Highest** run level from an elevated PowerShell window:

```powershell
.\start.ps1 restart -RunElevated
.\start.ps1 restart -RunLimited   # return to the default privilege level
```

`-RunElevated` gives the remote service administrator privileges, so holders of its access token can control applications at that privilege level. The chosen mode persists in `.run/windows-service.json`; ordinary starts and restarts preserve it. `status` and `doctor` show the task's actual run level. The launcher never elevates automatically. Elevated mode still cannot unlock Windows or operate the UAC secure desktop.

If your execution policy blocks `.ps1` files, use the `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` prefix shown above. To install through SSH, use `start` and optionally `-InteractiveUser 'COMPUTER\user'`. SSH runs in Session 0, so running `server.js` directly through SSH cannot capture or control the desktop. The scheduled task needs that user to be signed in. Windows lock/sign-in screens, UAC secure desktops, and applications running at higher integrity are unavailable to this Limited task. On an unavailable desktop, the agent reports blocked capture/control and retries when the interactive desktop returns.

## Service commands

```bash
./start.sh             # install/start; leave a healthy instance running
./start.sh status      # check HTTP, authentication and worker; show current URLs
./start.sh restart     # apply code/config updates, rebuild if needed, and restart
./start.sh stop        # stop while keeping login startup configuration
./start.sh logs        # follow the service log
./start.sh doctor      # check macOS, tools, build, and token state
./start.sh uninstall   # remove the launchd service; keep token and logs
```

`./remote.sh` remains a compatibility entry point for these commands. For foreground development, use `npm start`.

The configured port stays fixed: conflicts fail with an actionable error instead of silently changing the URL. DHCP can still change the computer's address; use a router reservation or static IPv4 setting for a stable LAN URL, and run the platform's `status` command to retrieve current links. Logs and launchd configuration may contain access credentials, so the launcher restricts them to the current user. Opening the permission guide does not rebuild or re-sign unchanged helpers.

## Mobile controls

| Gesture | Trackpad mode | Direct-touch mode |
| --- | --- | --- |
| One-finger move | Move pointer with acceleration | Move pointer to touch position |
| Tap / double tap | Click / double-click | Click / double-click at position |
| Double tap, hold, move | Drag | — |
| Hold, then move | — | Drag after 0.3 seconds |
| Long press | Right-click | Right-click |
| Two-finger move | Inertial scroll | Inertial scroll |
| Two-finger tap | Right-click | Right-click |
| Pinch | Zoom remote view | Zoom remote view |

The first mobile visit displays an in-app gesture guide. The bottom dock exposes mode switching, keyboard, right-click, drag lock, and view tools.

### Text and multiple viewers

- The keyboard field sends text after input-method commitment. Use the long-text editor to revise drafts before sending. Local draft edits never backspace through the remote application; use the remote Backspace button for deletion.
- Each send is limited to 4,000 UTF-16 code units. Oversized messages are rejected in full; split them manually. Failed sends preserve the text, and reconnection never automatically replays it.
- A text acknowledgement means the complete command was handed to the native input process, not that the target application saved or finished applying it. Check the host before retrying an uncertain send after a disconnect or permission change.
- **Restore last text** places the most recently submitted text back into the draft without resending it. This recovery copy is kept only in page memory and disappears on reload.
- Multiple devices may view simultaneously. While one device holds a mouse button or drags, other devices cannot control the host. Blur, pause, disconnect, and stale-connection cleanup release held input.

## Configuration

Copy `.env.example` to `.env`, or export variables before starting:

```bash
cp .env.example .env
./start.sh restart
```

| Variable | Default | Description |
| --- | ---: | --- |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to disable LAN access. |
| `PORT` | `8787` | HTTP/WebSocket port. |
| `FPS` | `15` | Capture frame rate, clamped to 1–30. |
| `QUALITY` | `0.6` | JPEG quality, clamped to 0.2–0.95. |
| `MAX_WIDTH` | `1920` | Maximum capture width, clamped to 640–3840. |
| `MAX_CLIENTS` | `4` | Concurrent browser clients, clamped to 1–32. |
| `REMOTE_TOKEN` | generated | Optional fixed secret; a random token is safer for most users. |

## Architecture

```text
Mobile or desktop browser
  ↕ HTTP + authenticated WebSocket (JPEG frames / JSON input)
Per-user launchd app launcher / Windows interactive scheduled task
  ↳ Node.js server (auth, backpressure, lifecycle, static client)
  ↕ framed stdout + newline-delimited JSON stdin
Swift agent (ScreenCaptureKit + CGEvent) / C# agent (desktop capture + SendInput)
```

The server discards frames for slow clients instead of building latency. It also releases pressed mouse buttons when a browser disconnects, restarts a failed native agent with backoff, validates browser WebSocket origins, and limits concurrent clients.

## Development

```bash
npm ci
npm test
npm run build:native
npm run test:native
npm start
```

`npm run check` runs JavaScript regressions, the platform's native build, and native self-tests. HTTP/WebSocket tests use an isolated worker substitute; native self-tests do not prompt for permissions, capture the screen, or inject input. Windows checks must also run on real Windows; cross-platform JavaScript tests do not prove interactive desktop capture or input. Physical phones, sleep/wake, and display hot-plug still require device testing. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before a substantial change.

## Security and limitations

- Use only on a trusted LAN; the token grants full view-and-control access.
- There is no TLS, account system, audit log, clipboard sync, file transfer, NAT traversal, or cloud relay.
- macOS captures the main display; Windows can select an available display.
- Hosts support macOS and Windows. Linux is not supported.
- Windows requires a signed-in desktop; this tool cannot unlock Windows or control UAC secure desktops. The default Limited task cannot control elevated applications.
- Browser capabilities differ. Wake Lock and fullscreen may require a user gesture and behave differently on iOS.

See [SECURITY.md](SECURITY.md) for the trust boundary and private reporting guidance.

## License

[MIT](LICENSE)
