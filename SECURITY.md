# Security Policy

## Intended trust boundary

Local Remote is designed for trusted local networks only. It does not provide TLS, user accounts, internet discovery, NAT traversal, or protection suitable for exposure to the public internet. Do not configure router port forwarding or a public reverse proxy for this service.

Anyone holding the access URL can view and control the Mac. Treat the URL and `.run/token` as credentials. The generated token is stored with owner-only file permissions and is removed from the browser address bar after the page loads.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue containing an access token, network address, screen capture, or exploit details.

Include the affected version or commit, impact, reproduction steps, and any suggested mitigation. Maintainers will acknowledge a complete report as soon as practical.

## Supported versions

Security fixes are applied to the latest release and the `main` branch.
