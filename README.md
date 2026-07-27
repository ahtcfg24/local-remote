# Local Remote

[中文](README.zh-CN.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

An open-source, mobile-first remote control for macOS on a trusted local network. View and control your Mac from Safari, Chrome, or another modern browser—nothing needs to be installed on the phone.

> Local Remote is intentionally LAN-only. It has no TLS or account system. Never expose its port to the public internet.

## Why Local Remote?

- **Phone-first control:** trackpad and direct-touch modes, drag, right-click, inertial scrolling, pinch-to-zoom, landscape view, and fullscreen.
- **Useful keyboard support:** Chinese and other IME text, modifier keys, navigation keys, long text, and common macOS shortcuts.
- **Low-latency native capture:** ScreenCaptureKit streams changed frames while CGEvent handles ordered mouse and keyboard input.
- **Zero-install client:** scan the terminal QR code and use the browser already on your phone.
- **Local and transparent:** no cloud relay, analytics, account, or third-party runtime service.
- **Managed on macOS:** one command installs a per-user launchd service with login startup and crash recovery.

## Requirements

- macOS 13 or newer
- Node.js 20 or newer
- A phone or computer on the same trusted LAN
- Screen Recording and Accessibility permissions on the Mac

## Quick start

```bash
git clone https://github.com/ahtcfg24/local-remote.git
cd local-remote
./start.sh
```

The script installs dependencies, builds the native helpers, starts a launchd user service, and prints access URLs. Scan the QR code shown in the log or open a printed URL such as:

```text
http://192.168.1.8:8787/?token=<generated-secret>
```

The random 256-bit token persists in `.run/token` with owner-only permissions. After loading, the browser keeps it in session storage and removes it from the visible address bar. Use **Copy link** when you intentionally need the complete access URL.

### macOS permissions

Local Remote needs:

- **Screen Recording** to capture the main display.
- **Accessibility** to inject mouse and keyboard events.

Select **Permission guide** in the web app or run:

```bash
./remote.sh guide
```

After granting Screen Recording, restart the service if capture does not begin automatically.

## Service commands

```bash
./start.sh             # install or update, then start
./start.sh status      # show service state and local access URL
./start.sh restart     # rebuild configuration and restart
./start.sh stop        # stop while keeping login startup configuration
./start.sh logs        # follow the service log
./start.sh doctor      # check macOS, tools, build, and token state
./start.sh uninstall   # remove the launchd service; keep token and logs
```

`./remote.sh` remains a compatibility entry point for these commands. For foreground development, use `npm start`.

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
Node.js server (auth, backpressure, lifecycle, static client)
  ↕ framed stdout + newline-delimited JSON stdin
Swift agent (ScreenCaptureKit + VideoToolbox + CGEvent)
```

The server discards frames for slow clients instead of building latency. It also releases pressed mouse buttons when a browser disconnects, restarts a failed native agent with backoff, validates browser WebSocket origins, and limits concurrent clients.

## Development

```bash
npm ci
npm test
npm run build:native
npm start
```

CI runs the JavaScript tests and native Swift build on macOS. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before a substantial change.

## Security and limitations

- Use only on a trusted LAN; the token grants full view-and-control access.
- There is no TLS, account system, audit log, clipboard sync, file transfer, NAT traversal, or cloud relay.
- Only the main display is currently supported.
- The host must be macOS; Linux and Windows are not supported.
- Browser capabilities differ. Wake Lock and fullscreen may require a user gesture and behave differently on iOS.

See [SECURITY.md](SECURITY.md) for the trust boundary and private reporting guidance.

## License

[MIT](LICENSE)
