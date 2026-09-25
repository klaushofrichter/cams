# cams

[![Release](https://img.shields.io/github/v/release/klaushofrichter/cams)](https://github.com/klaushofrichter/cams/releases)
[![PR checks](https://github.com/klaushofrichter/cams/actions/workflows/production-checks.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/production-checks.yml)
[![Build and publish image](https://github.com/klaushofrichter/cams/actions/workflows/build-push.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/build-push.yml)
[![Deploy production](https://github.com/klaushofrichter/cams/actions/workflows/deploy-production.yml/badge.svg)](https://github.com/klaushofrichter/cams/actions/workflows/deploy-production.yml)
<!-- Static badge: Dependabot has no status endpoint; alerts and security fixes are enabled in repo settings. -->
![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot)

Private viewer for Skylar Technology's Reolink security cameras, at
<https://cams.skylar.technology>: live video, recorded events with AI detection,
clip playback and downloads, and camera settings, behind Google sign-in.

## How it fits together

- `server/`: Express 5 + TypeScript. Google OAuth, sessions, `/health`, the JSON API, and serving the web build.
- `web/`: Svelte 5 + Vite. `index.html` is the public landing page; `app.html` is the signed-in app.
- The app runs as a Knative service on the k3s cluster. Its manifests live in the `kube-setup` repo, not here.

## Development

```bash
npm ci
cp .env.example .env     # fill in values
npm run dev              # server on :8080
npm run dev:web          # Vite on :5173, proxying /api and /auth to :8080
```

## Testing

```bash
npm test                 # vitest: server + web libraries
npm run build && npm run test:e2e   # Playwright, desktop and phone viewports
```

The e2e suite signs its own session cookie with a test secret (`e2e/session.ts`), so it never talks to Google.

## Deployment and releases

`main` is built and published as `ghcr.io/klaushofrichter/cams:main` but never deployed. A PR from `main` to `production` runs `test`, `e2e` and `codeql`; merging it deploys through the in-cluster runner, smoke-tests the public URL and creates a `vYYYY.MM.DD.N` release.

## Security

- **Sign-in:** Google OAuth with an email allow-list re-checked on every request.
- **Session:** an httpOnly, Secure, SameSite=Lax cookie.
- **Other protections:** a same-origin check on state-changing API calls, and rate limits on sign-in and the API.
- **Container:** runs as uid 1000 with all capabilities dropped.
