# cams

Camera viewer for Reolink cameras at cams.skylar.technology. Spec: `docs/superpowers/specs/2026-09-25-cams-design.md`. Plans: `docs/superpowers/plans/`.

## Commands

- `npm test`: vitest, two projects: `node` (server tests in `test/`, web lib tests in `web/src/lib/*.test.ts`) and `components` (Svelte component tests in `web/src/components|pages/*.test.ts`, jsdom). The camera is [cam-sim](https://github.com/klaushofrichter/cam-sim) (a release tarball in package.json); cam-proxy is a fake (`test/proxy/fakeProxy.ts`, also run by e2e on :8095). The e2e camera Silo has the real cam-proxy instead (`e2e/realProxy.ts`: its released Docker image, pinned in `e2e/env.ts` by tag and digest, `CAM_PROXY_TAG` and `CAM_PROXY_DIGEST`; bump both, the digest being the index's `Digest:` line from `docker buildx imagetools inspect <image>:<tag>`, not a per-platform manifest; host networking), on GitHub Actions only (or `CAMS_E2E_REAL_PROXY=1`, Linux only); elsewhere its spec is skipped. Never run it on a Mac or the home LAN.
- `npm run build`: `tsc` for the server plus `vite build` for the web app. tsc is the only server type-checker, so run the build.
- `npm run check`: `tsc --noEmit` over `web/` TypeScript (svelte-check doesn't support TypeScript 7 yet, so .svelte files aren't type-checked)
- `npm run lint:types`: `tsc --noEmit -p tsconfig.check.json` over `server/`, `test/` and `e2e/` (with the DOM lib, for page.evaluate and jsdom code). Runs in the `test` check.
- `npm run test:e2e`: Playwright. It runs the BUILT server on :8099 and reuses one already running there locally, so rebuild first.
- `npm run dev` / `npm run dev:web`: local server and Vite dev server
- `scripts/livestack/`: the local live-stack harness (all suites; cam-sim or the real camera → cam-proxy → cams, 23 checks), see `docs/livestack.md`. Its work dir is outside the repo. The real-camera part needs the Pi's proxy stopped: Klaus runs or approves it.

## Branches and releases

- Work on `main` (or a feature branch, then a PR to main). `main` builds `:main` only and is never deployed.
- To deploy: PR `main` -> `production` (required checks `test`, `e2e`, `codeql`), then merge.
- The version is generated at deploy time (`YYYY.MM.DD.N`). Never store a version in the sources.
- Put user-visible changes under `## [Unreleased]` in CHANGELOG.md; the deploy moves them into the release notes.

## Rules that are easy to break

- Don't run Playwright on the self-hosted runner (OOM). It runs in production-checks.yml on GitHub runners.
- Don't push `:<sha>`, `:v*` or `:latest` from build-push.yml. deploy-production.yml is their only writer.
- With a cam-proxy configured, the day/month lists, clips and thumbnails come from the proxy's recordings API (SD card) first, then its FTP copy (never for 4K), then the camera's own Download behind a breaker; stills come from the proxy. Keep the fake proxy (`test/proxy/fakeProxy.ts`, seeded by `e2e/fakeProxyData.ts`) in step with cam-proxy's client API.
- Camera behaviour comes from the real camera, not the Reolink docs: see `docs/reolink-api.md`. A difference between the camera and cam-sim is an issue in the cam-sim repo, not a workaround here.
- Cluster manifests live in kube-setup (`manifests/cams/`). Ask the kube-setup session for changes; don't edit that repo from here.
- Never log camera passwords, tokens, cookies or client IPs. Detailed payloads go at debug level only (debug stays in the cluster).
- Every colour comes from the CSS tokens in `web/src/styles/theme.css`, scrollbars included.
- Every new UI element used by e2e gets a `data-testid`, and e2e runs at desktop (1440x900) and phone (390x844).
- `.superpowers/` is gitignored scratch space for plans' work artifacts, and none of it is committed.
