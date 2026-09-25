# cams

Camera viewer for Reolink cameras at cams.skylar.technology. Spec: `docs/superpowers/specs/2026-09-25-cams-design.md`. Plans: `docs/superpowers/plans/`.

## Commands

- `npm test`: vitest (server tests in `test/`, web lib tests in `web/src/**/*.test.ts`)
- `npm run build`: `tsc` for the server plus `vite build` for the web app. tsc is the only server type-checker, so run the build.
- `npm run check`: `tsc --noEmit` over `web/` TypeScript (svelte-check doesn't support TypeScript 7 yet, so .svelte files aren't type-checked)
- `npm run test:e2e`: Playwright. It runs the BUILT server on :8099 and reuses one already running there locally, so rebuild first.
- `npm run dev` / `npm run dev:web`: local server and Vite dev server

## Branches and releases

- Work on `main` (or a feature branch, then a PR to main). `main` builds `:main` only and is never deployed.
- To deploy: PR `main` -> `production` (required checks `test`, `e2e`, `codeql`), then merge.
- The version is generated at deploy time (`YYYY.MM.DD.N`). Never store a version in the sources.
- Put user-visible changes under `## [Unreleased]` in CHANGELOG.md; the deploy moves them into the release notes.

## Rules that are easy to break

- Don't run Playwright on the self-hosted runner (OOM). It runs in production-checks.yml on GitHub runners.
- Don't push `:<sha>`, `:v*` or `:latest` from build-push.yml. deploy-production.yml is their only writer.
- Cluster manifests live in kube-setup (`manifests/cams/`). Ask the kube-setup session for changes; don't edit that repo from here.
- Never log camera passwords, tokens, cookies or client IPs. Detailed payloads go at debug level only (debug stays in the cluster).
- Every colour comes from the CSS tokens in `web/src/styles/theme.css`, scrollbars included.
- Every new UI element used by e2e gets a `data-testid`, and e2e runs at desktop (1440x900) and phone (390x844).
- `.superpowers/` is gitignored scratch space for plans' work artifacts, and none of it is committed.
