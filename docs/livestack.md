# Live-stack test harness

`scripts/livestack/` runs the whole chain locally, **cams → cam-proxy →
camera**, from the three repos' `origin/main`, and checks it end to end
through the APIs a browser uses.

## Why

The automated suites test each repo on its own: cams' unit tests and e2e use
cam-sim and a fake cam-proxy. The one round trip with the real cam-proxy in CI
is the e2e cameras **Silo** and **Loft**, two cameras of one cam-proxy
(`e2e/realProxy.spec.ts`), and it runs only on
GitHub Actions (the released cam-proxy image with host networking; skipped on
a Mac). Nothing in CI talks to the real camera.

The harness fills that gap, by hand and on demand:

1. **All suites**: unit + build + e2e of cam-sim, cam-proxy and cams on
   `origin/main` (`run-all-suites.sh`).
2. **The sim stack**: cam-sim → cam-proxy → cams, built from `origin/main`,
   with the 23 checks (`start-sim-stack.sh`, `check-stack.sh`). Safe to run any
   time; it never leaves 127.0.0.1.
3. **The real camera**: the real camera → a local cam-proxy → a local cams,
   with the same 23 checks (`start-real-stack.sh`, `check-stack.sh`). Needs the
   Pi's cam-proxy stopped for a minute or two, so Klaus runs or approves it.
4. **Two proxies**: one cams with two cam-proxies, each with its own cam-sim
   (`start-two-proxy-stack.sh`, `check-two-proxy.sh`). Safe any time, like 2;
   see [Two proxies](#4-two-proxies).

Run them in that order: a failure in 1 or 2 is cheaper to find than in 3.

## Files

| File | What it does |
|---|---|
| `lib.sh` | Shared paths and helpers (sourced): work dir, repos, worktrees, secrets, start/wait |
| `run-all-suites.sh` | Part 1: the suites of the three repos, one repo at a time |
| `start-sim-stack.sh` | Part 2: starts cam-sim, cam-proxy and cams on 127.0.0.1 |
| `start-real-stack.sh` | Part 3: starts cam-proxy and cams on 127.0.0.1 against the real camera |
| `check-stack.sh` | The 23 checks against a running stack |
| `start-two-proxy-stack.sh` | Part 4: two cam-sims, two cam-proxies and one cams on 127.0.0.1, cams' `cameras.json` from the generator; `--stop-proxy-b` / `--start-proxy-b` for the outage check |
| `check-two-proxy.sh` | Part 4's checks: `two-proxy.spec.ts` (Playwright, config `two-proxy.config.ts`, run.env read by `two-proxy-env.ts`), then the generator again |
| `stop-stack.sh` | Stops the stack it started; `--clean` also deletes the run data and the worktrees |
| `bind-local.cjs` | `node --require` preload for cams and cam-proxy: binds every listener to 127.0.0.1 (neither has a bind option) |
| `sim-local.cjs` | cam-sim's CLI with `listen(ports, '127.0.0.1')`, so MediaMTX's RTSP is local too |

## Paths and prerequisites

Everything a run makes lives in the **work dir**, outside the repo:
`$LIVESTACK_DIR`, default `${TMPDIR:-/tmp}/cams-livestack`. The scripts refuse
a work dir inside the repo. It holds the detached worktrees (`src-cam-sim`,
`src-cam-proxy`, `src-cams`; `npm ci` + `npm run build` once per commit;
`LIVESTACK_REFRESH=1` moves them to the newest `origin/main`), `run/`
(configs, data, secrets), `run.env` (the run's tokens, mode 600), `logs/`,
`pids`, `fixtures/` (cam-sim's generated test patterns, kept between runs) and
`suites/` (part 1).

The sibling repos default to `~/Development/<repo>`:

| Variable | Default |
|---|---|
| `LIVESTACK_DEV_DIR` | `~/Development` |
| `LIVESTACK_CAM_SIM_REPO`, `LIVESTACK_CAM_PROXY_REPO` | `$LIVESTACK_DEV_DIR/cam-sim`, `…/cam-proxy` |
| `LIVESTACK_REOLINK_DIR` | `$LIVESTACK_DEV_DIR/reolink` (its `.env` has `REOLINK_IP`; part 3 only) |
| `LIVESTACK_CAMS_REPO` | this repo |
| `GO2RTC_BIN`, `MEDIAMTX_BIN` | `cam-proxy/tools/go2rtc`, `cam-sim/tools/mediamtx` (their install scripts) |

Tools: node + npm, git, jq, ffmpeg, openssl, curl, lsof, xxd; Google Chrome
for part 1 (cams e2e).

**Secrets.** The sim stack makes every password and token at random per run.
The real stack reads two keys at run time, without sourcing the files and
without printing them: `REOLINK_IP` from `reolink/.env` and
`CAMPROXY_CAMERA_PASSWORD` from `cam-proxy/.env`. Secrets go to
`run/secrets/` (mode 600) and reach cam-proxy and cam-sim through their
`*_FILE` variables; cams' cameras file `run/cams/cameras.json` is mode 600.
check-stack.sh passes tokens to curl through header files, never on a command
line. No secret is in this repo.

## Ports

All listeners bind 127.0.0.1 (cams and cam-proxy through `bind-local.cjs`,
cam-sim and MediaMTX through `sim-local.cjs`, go2rtc by cam-proxy's own
config). The suites use 8090-8099, 8190-8598, 18480, 18600 and 18601, so a
stack can run next to them.

| Stack | cam-sim | cam-proxy | cams |
|---|---|---|---|
| sim | http 19080, https 19443, control+UI 19943, rtsp 19554, onvif 19800, baichuan 19900 | 19480 (go2rtc 19555/19984, FTPS 19221, passive 19230-19239) | 19580, camera `simcam` |
| real | none: the camera (https, onvif 8000, rtsp 554, baichuan 9000) | 19481 (go2rtc 19556/19985, no FTP) | 19581, camera `cam1` |
| two proxies | #n (A = 1, B = 2…): base 19600 + 10·(n-1): http +0, https +1, control+UI +2, rtsp +3, onvif +4, baichuan +5 | A 19680 (go2rtc 19681/19682, FTPS 19683, passive 19690-19699); B 19780 (go2rtc 19781/19782, FTPS 19783, passive 19790-19799, 10 more per further camera) | 19880, cameras `a-cam1`, `b-cam1` (… `b-camN`) |

The stacks share the work dir, its `run/` and its pids file: one stack at a
time (a start refuses while one runs), and `stop-stack.sh` stops whichever it is.

## 1. All suites

```sh
scripts/livestack/run-all-suites.sh
```

For each of cam-sim, cam-proxy, cams: a fresh worktree of `origin/main` in
`$LIVESTACK_DIR/suites/`, `npm ci`, `vitest run`, `npm run build`,
`playwright test`. One repo at a time (their e2e suites share ports). It prints
one line per suite; logs are in `$LIVESTACK_DIR/suites/`. cams' Silo spec is
skipped on a Mac, as in any local run (it runs in CI).

## 2. The sim stack

```sh
scripts/livestack/start-sim-stack.sh
sleep 60     # the 20 s person event's clip reaches the proxy by FTP
scripts/livestack/check-stack.sh http://127.0.0.1:19480 http://127.0.0.1:19580 simcam
scripts/livestack/stop-stack.sh            # or --clean to delete run data and worktrees
```

cam-sim refuses HTTP Download (`downloads.refuse`, like the real camera since
2026-10-01), so recordings must come over Baichuan. It seeds four recordings
today and two yesterday (`demo`), makes events on its own
(`motion:6/h,person:2/h`), gets one 20 s person event at start, and uploads
the sub stream by FTPS to the proxy. cam-sim has two users with random
passwords: `proxy` (cam-proxy) and `cams` (cams), as on the real camera. The
first start builds the three repos and generates cam-sim's fixtures, a few
minutes; later starts take seconds.

## 3. The real camera

The real stack uses the camera like the Pi does, so **the Pi's cam-proxy must
be stopped first**: one cam-proxy per camera (its `proxy` user, its ONVIF
subscription, its Baichuan session). Stopping the Pi is Klaus's call. Each
step below is a command Klaus runs, or approves before it is run. Keep the
whole window short (today's: 91 s).

```sh
# 1. Stop the Pi's proxy (the container stays, with its data).
ssh admin@192.168.1.220 'cd /srv/cam-proxy && docker compose stop'

# 2. Start the local real stack, give it ~30 s, check.
scripts/livestack/start-real-stack.sh
sleep 30
scripts/livestack/check-stack.sh http://127.0.0.1:19481 http://127.0.0.1:19581 cam1

# 3. Stop it and delete its data (camera footage) and worktrees.
scripts/livestack/stop-stack.sh --clean

# 4. Start the Pi again and verify it.
ssh admin@192.168.1.220 'cd /srv/cam-proxy && docker compose start'
curl -s http://192.168.1.220:8480/health          # {"ok":true,...}
ssh admin@192.168.1.220 'cd /srv/cam-proxy && T="$(sed -n "s/^CAMPROXY_ADMIN_TOKEN=//p" .env)" &&
  curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8480/control/status |
  jq "{online: .camera.online, onvif: .intake.onvif, stream: .stream.up, ftp: .ftp.listening}"'
# expect: online true, onvif "subscribed", stream true, ftp true
```

The token is read on the Pi and used there; it is never printed. Then open
cams.skylar.technology and check that cam1 is online again.

What the local proxy does differently from the Pi: FTP off (the camera's FTP
target stays the Pi and is not touched), no PoE switch (it can never
power-cycle the camera), Google Vision off. Toward the camera it does only
what the Pi does: HTTP login/status/Search/Snap, an ONVIF subscription, one
RTSP reader for stills, Baichuan downloads. Nothing writes a camera setting,
and check-stack.sh never starts a repair. Local cams signs in to the camera as
`proxy` too (production cams has its own `cams` user, whose password is only
in the cluster Secret); `CAMS_CAMERA_USER`, `CAMS_CAMERA_PASSWORD_KEY` and
`CAMS_CAMERA_PASSWORD_ENV_FILE` name another.

**While the Pi is down:**
- The camera's FTP uploads go nowhere: clips of events in that window are not
  copied. They stay on the camera's SD card, and cam-proxy's clip repair can
  fetch them later.
- cams.skylar.technology shows cam1 offline until the Pi is back; cams
  reconnects on its own.

**Cleanup.** `stop-stack.sh --clean` deletes `run/` (the real run's
`proxy-data` and cams cache hold camera video and stills), `run.env`, `logs/`,
`fixtures/` and `suites/`, and removes the worktrees from their repos. Never
upload anything from a real run.

## 4. Two proxies

One cams with two cam-proxies (cam-proxy spec 2026-10-05: several proxy
hosts; cams' P3, proxy groups and the `cameras.json` generator):

```
cam-sim A "Alpha" ──> cam-proxy A ──┐
                                    ├──> cams   (a-cam1 = cam1 on A, b-cam1 = cam1 on B)
cam-sim B "Bravo" ──> cam-proxy B ──┘
```

```sh
npm ci                                       # once, in this checkout: Playwright and tsx
scripts/livestack/start-two-proxy-stack.sh
scripts/livestack/check-two-proxy.sh         # ~2 min; Google Chrome
scripts/livestack/stop-stack.sh              # or --clean
```

**What runs.** cam-sim from `origin/main` (as in part 2, but no automatic
events: every event in a check is one the check triggered, so it can tell
which proxy it must reach and which not). cam-proxy at its **newest release
tag** (`TWOPROXY_PROXY_REF`, proxy B `TWOPROXY_PROXY_B_REF`), two processes
with their own config, `dataDir`, client and admin tokens, FTP account and
ports; Google Vision off in both configs and its key dropped from their
environment. cams at **this checkout's HEAD commit** (`TWOPROXY_CAMS_REF`), so
commit before a run. Each proxy's worktree is `src-cam-proxy-<ref>`, cams'
`src-cams-<commit>`.

Both proxies call their camera `cam1`, the default look of a one-camera
proxy. The generator's input (`run/cams/cameras-config.json`, mode 600; every
secret a `{"file": …}` into `run/secrets-a` or `run/secrets-b`) gives them the
prefixes `a-` and `b-`, plain http on loopback, no pins (cam-proxy P5, the
site CA, isn't done). The start script runs the generator as a dry run (the
diff, secrets as `•••`), then with `--write`, and starts cams on its result.

**The checks** (`check-two-proxy.sh`; a failed step is reported and the
next ones still run):

| # | Check | Proves |
|---|---|---|
| 1 | both cameras listed | the generated `cameras.json`: both cameras, their proxy's names, each with a proxy; the picker shows both |
| 1a | one event stream per cam-proxy | each proxy lists its cameras, and has exactly one SSE client (cams), however many cameras it serves; a proxy with several says `sse-cam-list` |
| 2, 3 | live view and snapshot, per camera | the Video page: name, online, its proxy reachable, the live stream plays (`● LIVE`, the top bar's indicator streaming), the camera's Snap |
| 4 | stills, a clip and a notice per camera | a person event on each cam-sim: each proxy's stills and latest still through cams; the event's recording listed and its clip played (FTP to its own proxy); the top bar shows "Person on Alpha" and "Person on Bravo" |
| 5, 6 | an event on one camera never shows for the other | a vehicle event on one cam-sim: cams relays it and shows its notice for that camera, and nothing (no camera event, no clip, no notice) for the other, both ways. Both proxies say `cam1`: a mix-up in cams' per-proxy fan-out shows here |
| 7a | a multi-camera proxy's Archive (`TWOPROXY_B_CAMS` > 1; else skipped) | `/api/archive` lists proxy B once, via `b-cam1`, with all its cameras; Bravo 2's clip, archived through cams, is kept on proxy B, listed with `b-cam2`; a ZIP of it alone is named `archive-b-cam2-…` (the proxy itself says `archive-all-…`); the clip is deleted again |
| 7 | the Archive merges both proxies | one clip archived on each (`POST /api/cameras/<id>/archive`, job polled to `done`); `/api/archive` lists both with the right camera and its proxy (`via`), both proxies ok; the Archive page shows both rows, each with its camera; selecting both and **Download ZIP** gives two ZIPs, one per proxy, each a ZIP named by its proxy |
| 8 | proxy B down | `--stop-proxy-b`: cams relays B's proxy as down; B's "Proxy" mark is unreachable and its stills answer 502; camera A plays live, has stills, and its events and notices go on; the Archive lists A's clip and says Bravo's proxy didn't answer |
| 9 | proxy B back | `--start-proxy-b`: B's proxy up again; for 15 s nothing for B is relayed or shown (no old event replayed as a notice); a new event on B shows "Person on Bravo", once; the Archive lists both again |
| 10 | generator again | a dry run of the generator on the same input finds `(no changes)` |

check-two-proxy.sh starts proxy B again if the spec left it stopped.
Playwright's results (traces of failed steps) go to
`$TMPDIR/cams-livestack-two-proxy-results`.

**Before a run**, as for every Playwright run here: no other worktree's
Playwright, cam-sim, fake proxy or cams server may be on the stack's ports
(`ps aux | grep -E "playwright|cam-sim|fakeProxy|dist/server"`). The stack's
ports (19600-19899) clash with none of the e2e suites' (8090-8099,
8190-8598, 18480-18602) or the other stacks'.

**The multi-camera stack: proxy B with several cameras (cam-proxy P1+P2,
released in v2026.10.05.7; cams P3 plan Task 12).** `TWOPROXY_B_CAMS=N` (1 to
4, default 1) starts N cam-sims behind proxy B ("Bravo", "Bravo 2", …; cams
ids `b-cam1` … `b-camN`) and writes proxy B's config with the `cameras` list
instead of `camera`, each camera uploading its clips by FTPS as its own user
(P2; proxy B's passive range grows by 10 ports per camera). The newest
release has P1+P2, so no ref is needed:

```sh
TWOPROXY_B_CAMS=3 scripts/livestack/start-two-proxy-stack.sh
scripts/livestack/check-two-proxy.sh
scripts/livestack/stop-stack.sh
```

That is cams → one cam-proxy → three cam-sims (proxy B), next to proxy A's
one camera. A cam-proxy without P1+P2 (`TWOPROXY_PROXY_B_REF` older than
v2026.10.05.7) refuses that config, and the script stops there and says so.
The checks then cover every camera: live view, snapshot, stills, a clip and a
notice for Bravo 2 and 3 too; an event on any camera never shows for the
others (also between neighbours on proxy B); one SSE client on proxy B for its
three cameras (1a); the Archive of the multi-camera proxy and its ZIP name
(7a); with proxy B down, all of its cameras show it unreachable. The other
Archive steps and the restart step use Bravo.

## 5. cams-admin mode and the cut-over rehearsal (migration P4)

The cams side of the cut-over rehearsal (cams-admin `docs/migration-p4-runbook.md` §R step 4) runs on **cams-admin's local stack** (cams-admin, real cam-proxies and cam-sims, all on 127.0.0.1; its `docs/localstack.md`), not on this harness's sims:

```bash
(cd ~/Development/cams-admin && LOCALSTACK_DIR=$W scripts/localstack/start.sh --no-s3)
LOCALSTACK_DIR=$W scripts/livestack/rehearse-cutover.sh
(cd ~/Development/cams-admin && LOCALSTACK_DIR=$W scripts/localstack/stop.sh)
```

Two real cams processes from this repo's build (`cluster` on :29610 with both proxies of account `beta`, `pi` on :29611 with the first proxy only) go through: P2 managed tokens and their `cameras.json`; `export-config` (no password, hashes only); `admin-enroll` (code on stdin, fingerprint printed); imports (dry run, apply, again = no changes; the Pi file with `hideUnlisted`); `shadow` with 0 differences on both and its rollback; `cams-admin` mode (the Pi sees only its proxy: routes are default-deny), the token sign-in, cams's own tokens active (managed 4, legacy 0); a start with cams-admin unreachable (the signed cache); Rotate now with a request loop (0 failures); a held camera host confirmed; the rollback to `file` keeping preferences. PASS/FAIL per step and `result.json` in `$W/rehearse-cams` (test data, mode 600, never in git). In this stack cams-admin's bridge answers `tokens.apply` without installing the token on the real cam-proxy, so the proxies can't check cams-admin's tokens: the rotation is checked on cams's side (its `tokens.json` against the token rows, its report) and the request loop asks the cameras.

The browser checks of cams-admin mode (two accounts with the same `cam1`, the picker, a viewer, a held change, an offline start) are e2e specs against a fake cams-admin: `e2e/accounts.spec.ts`, `viewer.spec.ts`, `held.spec.ts`, `offline-start.spec.ts` (projects `admin-desktop`, `admin-phone`).

## What the 23 checks prove

check-stack.sh signs a cams session cookie with the run's `COOKIE_SECRET`
(the JWT cams' `server/session.ts` expects, for the stack's only allowed
email), so no Google sign-in is involved, and uses the run's cam-proxy client
and admin tokens. It sends GETs only, plus two read-only inventory runs.
Downloads go to a private temp folder that is deleted at the end. Exit status
0 only when all 23 pass.

| # | Check | Proves |
|---|---|---|
| 1 | cams `/health` | cams runs (`status: ok`) |
| 2 | proxy `/health` | cam-proxy runs (`ok: true`) |
| 3 | cams session (`/api/me`) | a session cookie signed with the run's secret is accepted |
| 4 | cams camera list | cams' registry has the camera with its proxy active |
| 5 | cams camera status | cams reaches the camera itself: online, model, firmware |
| 6 | proxy camera (client token) | the client token works; the proxy sees the camera online and its stream state |
| 7 | proxy recordings today (sub) | the proxy lists the SD card (HTTP Search) and links FTP clips |
| 8, 9 | cams History today, yesterday | cams' day lists come through (from the proxy) |
| 10 | cams uses proxy recordings | `downloads=proxy-recordings`: recordings come from the proxy's recordings API (SD card via Baichuan), not FTP copies or the camera's refused HTTP Download |
| 11 | cams month days | cams' calendar comes through |
| 12 | proxy month days | the proxy's calendar |
| 13 | play (video, sub) | a recording plays through cams → proxy → Baichuan: HTTP 200, MP4 `ftyp` |
| 14 | download sub | the same file downloads whole: bytes = Content-Length, `ftyp`, a file name |
| 15 | 4K available? (full-quality) | cams answers whether the main (4K) file can be fetched |
| 16 | download 4K (main) | the main file streams (first 2 MiB, `ftyp`), or cams answers 503 `full_quality_unavailable` consistent with `available=false` |
| 17 | event thumbnail | the thumbnail path (proxy still or clip frame) gives a JPEG |
| 18 | proxy stills (last 2 min) | the stills pipeline (go2rtc + ffmpeg on one RTSP reader) runs |
| 19 | cams latest still (proxy) | cams relays the newest still (JPEG, its age) |
| 20 | cams snapshot (camera Snap) | the camera's own Snap works through cams |
| 21 | proxy `/control/status` | the admin token works; the recordings card (Baichuan session, cache, downloads) |
| 22 | inventory stills | a read-only stills inventory finishes with outcome `ok` |
| 23 | clips compare (camera) | a read-only clips inventory, compared with the camera's SD card, finishes `ok` |

The inventory checks start a run with `POST /control/actions/inventory`
(retrying while another run holds the lock, 409) and poll its report until the
outcome is no longer `running`: the clips compare lists the SD card day by
day and can take minutes on the real camera. Neither is ever a repair.

## Results, 2026-10-03

| Part | Result |
|---|---|
| Suites, unit | cam-sim 469, cam-proxy 1080, cams 994: all passed |
| Suites, e2e | cam-sim 21, cam-proxy 34, cams 212 passed (33 skipped by design: viewport-specific specs and Silo, which runs on GitHub only) |
| Sim stack | 23/23 |
| Real camera | 23/23; the Pi's proxy was down 06:23:45-06:25:16 (91 s) |

## Results, two proxies, 2026-10-05

| Run | Result |
|---|---|
| cams #211 (P3) + 2 × cam-proxy v2026.10.05.5 | 8/9: both Archive ZIPs downloaded as `archive.zip` (cams accepted only the plain `filename="…"`; fixed in #215) |
| cams main b19923b (P3 + #215) + 2 × cam-proxy v2026.10.05.6 | 9/9, generator re-run no-op |
| same, proxy B with two cam-sims (`TWOPROXY_B_CAMS=2`, P1) | 11/11, generator re-run no-op |
| cams fb5e63f (P3 tasks 11–12, PR #224) + 2 × cam-proxy v2026.10.05.7, proxy B with three cam-sims (`TWOPROXY_B_CAMS=3`, P1+P2: an FTP user each, all three uploaded clips) | 15/15, generator re-run no-op |
