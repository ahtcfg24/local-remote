# Security Policy

## Intended trust boundary

Local Remote is designed for trusted local networks only. It does not provide TLS, user accounts, internet discovery, NAT traversal, or protection suitable for exposure to the public internet. Do not configure router port forwarding or a public reverse proxy for this service.

Anyone holding the access URL can view and control the Mac. Treat the URL and `.run/token` as credentials. The generated token is stored with owner-only file permissions and is removed from the browser address bar after the page loads.

New pairing links use `#token=` to keep the credential out of the initial page request. HTTP API calls use bearer authentication, while the WebSocket handshake still carries a token query parameter. Traffic remains unencrypted on HTTP. Logs and launchd configuration can contain access links or credentials; the managed launcher restricts their permissions. Do not attach them unredacted to reports.

HTTP API and WebSocket requests validate browser origins. Control inputs have numeric, size, rate, and queue bounds. These protections limit accidental or malformed traffic; they do not make an untrusted network safe. A pause button is a local viewing preference, not a separate authorization role. Every paired device still holds full control authority.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue containing an access token, network address, screen capture, or exploit details.

Include the affected version or commit, impact, reproduction steps, and any suggested mitigation. Maintainers will acknowledge a complete report as soon as practical.

## Supported versions

Security fixes are applied to the latest release and the `main` branch.
