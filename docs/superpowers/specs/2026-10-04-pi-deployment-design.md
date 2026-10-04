# cams on the Pi: a self-contained demo kit

2026-10-04. Klaus approved running cams on the cam-proxy Raspberry Pi as a
demo kit: the Pi and the camera, nothing else. A browser on the LAN opens
`http://192.168.1.220:8080` (or the Pi's own browser `http://127.0.0.1:8080`),
signs in with a token, and sees the camera through the Pi's cam-proxy. No
cluster, no Google, no internet needed at the demo.

This needs three things in cams, and documentation:

1. an **arm64 image** (the Pi is a Pi 4, arm64);
2. a **token login**, since Google sign-in needs a public redirect URI and the
   internet;
3. **session cookies over http** on the LAN (the Pi has no certificate).

The cluster deployment stays as it is: Google sign-in, Secure cookies, the
same image tags (now multi-arch).

## 1. arm64 image

- `build-push.yml` (`:main`) and `deploy-production.yml` (`:<sha>`,
  `:v<version>`, `:latest`) build `linux/amd64,linux/arm64` with
  `docker/setup-qemu-action@v4` + `docker/setup-buildx-action@v4`, as
  cam-proxy's `build-push.yml` and `release.yml` do.
- The Dockerfile's builder stage runs on the build platform
  (`FROM --platform=$BUILDPLATFORM`): its output (`dist/`, JavaScript and the
  web bundle) is architecture-independent, so only the runtime stage
  (`apk add ffmpeg`, `npm ci --omit=dev`, all pure JavaScript dependencies)
  runs under QEMU. ffmpeg is in Alpine's arm64 (aarch64) community repository,
  the same package as on amd64.
- **Ruling: deploy-production.yml is split into a `build` job on
  `ubuntu-latest` and the existing `deploy` job on the self-hosted runner** —
  why: cam-proxy's release does exactly that (proven), the k3s runner has never
  run QEMU/binfmt (a privileged container) and a multi-arch build under QEMU on
  it would be slow and risk the OOM the runner already has with browsers; the
  version is computed in `build` and passed on as a job output — cost if wrong:
  one more job hop (about 30 s), and a deploy that fails at `build` leaves the
  cluster untouched, as before.
- The ksvc pins `:<sha>`, now an image index; k3s pulls its amd64 manifest. No
  kube-setup change.

## 2. Token login

### Configuration (read and checked at startup)

| Variable | |
|---|---|
| `CAMS_LOGIN_TOKEN` | the login token, 24 or more characters (after trimming surrounding whitespace) |
| `CAMS_LOGIN_TOKEN_FILE` | or: a file holding it (one line; surrounding whitespace trimmed) |
| `CAMS_TOKEN_USER` | the identity a token session has, default `local`; `[A-Za-z0-9._@-]`, 1 to 64 characters |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | now optional: all three or none |
| `ALLOWED_EMAILS` | required when Google is configured, else optional |
| `COOKIE_SECRET` | still always required (it signs every session) |
| `COOKIE_SECURE` | `true` (default) or `false`, see §3 |

Startup refuses (the error names the variable, never a value):

- a token shorter than 24 characters;
- both `CAMS_LOGIN_TOKEN` and `CAMS_LOGIN_TOKEN_FILE` set — **Ruling: refuse
  rather than pick one** — why: two sources for one secret means one of them
  is stale, and silently preferring one hides which — cost if wrong: one
  confusing start error for someone who set both on purpose;
- an unreadable token file;
- one or two of the three Google variables (a half-configured Google login
  would send users to a broken Google page);
- neither Google nor a token: nobody could sign in;
- `COOKIE_SECURE` other than `true`/`false`/`1`/`0`;
- an invalid `CAMS_TOKEN_USER`.

**Ruling: the token is read once (per distinct environment) and kept in
memory; a changed file takes effect on restart** — why: the same as every
other Secret here, and no file read per request — cost if wrong: rotating the
token needs `docker compose restart cams`, which the docs say.

### The start page

The server tells the start page which sign-ins exist through
`<meta name="cams-login" content="google token">` in `index.html` (the build
ships `content="google"`; `GET /` rewrites it). **Ruling: a meta tag, not an
API call** — why: the page renders the right buttons at once, with no flash
of a Google button that doesn't work and no extra unauthenticated endpoint —
cost if wrong: `GET /` reads `index.html` per request instead of `sendFile`
(a 1 kB file, rate-limited as before).

- **Google only** (the cluster): unchanged, "Sign in with Google".
- **Both:** "Sign in with Google" stays first and primary; below it a
  secondary "Sign in with token" button opens the token form.
- **Token only** (the Pi): the token form directly: a password field
  ("Login token") and a primary "Sign in with token" button.
- Errors under the form: "That token is not right.", "Too many attempts. Try
  again later.", "Sign-in failed. Try again."

The form posts JSON with `fetch` and, on success, goes where the server says.

### `POST /auth/token`

- Body: `{"token": "…"}` (JSON) or `token=…` (form). **Never in the URL:** a
  request with `token` in its query string is refused (400) and counts as a
  failure; the body is not logged (pino-http logs no bodies; the handler logs
  `token_login` / `token_login_failed` without token, user agent or address).
- Order: the auth rate limiter (`RATE_LIMIT_MAX` per window per address, as
  for Google), then the **failure limiter**: 10 failed attempts per 15 minutes
  per address (`RATE_LIMIT_TOKEN_FAILURES`), then the same-origin check
  (`requireSameOrigin`, as for every other cookie-changing POST; 403
  otherwise).
- **Ruling: the failure limiter is per address only, no global cap** — why: a
  24+ character random token can't be guessed at 10 tries per 15 minutes, and a
  global cap would let anyone on the LAN lock the owner out of the demo —
  cost if wrong: a distributed guesser gets 10 tries per address per 15 min,
  still hopeless against the required entropy.
- Compare: SHA-256 of the presented and of the configured token, compared with
  `crypto.timingSafeEqual` (equal-length digests, so neither the length nor a
  prefix of the token leaks through timing).
- Success: the same `session` cookie as Google (HS256 JWT, 7 days, the same
  attributes), whose payload is `{email: CAMS_TOKEN_USER, via: "token", tf}`;
  `tf` is a 16-hex fingerprint of the token (SHA-256 of a fixed prefix and the
  token). The `login_hint` and `oauth_state` cookies are cleared. The answer
  goes to the remembered `return_to` page when it passes `safeReturnPath`
  (#155's rules), else `/app/video`: JSON `200 {"redirect": "…"}`; a form
  post gets `303` to the same place.
- Failure: JSON `401 {"error": "invalid_token"}` (form: `303 /?login=failed`);
  too many: `429 {"error": "too_many_attempts"}`; token login off: `404`.

**Ruling: rotating the token signs out its sessions** (the `tf` claim must
match the current token) — why: a leaked token is fixed by changing it,
without also rotating `COOKIE_SECRET` and signing everyone out — cost if
wrong: after a rotation the demo browser must sign in again, which is the
point.

### Who is signed in

`currentUser()` (the one definition of "signed in") now has two cases:

- a token session (`via: "token"`): valid while token login is on, its
  `email` equals `CAMS_TOKEN_USER` and `tf` matches. It **bypasses
  `ALLOWED_EMAILS`**, and only this kind of session does: a Google session
  whose address happens to equal `CAMS_TOKEN_USER` is still checked against
  the allowlist;
- any other session: the allowlist, as before.

Everything else (preferences keyed by the identity, `/api/me` returning it,
still-check limits per user) treats the token user as one more user.

### Logout, expiry, silent renewal

- Logout is unchanged (clears the cookies, back to `/`).
- The silent Google renewal (#155) is skipped for token sessions: `GET
  /auth/google/login?silent=1` with an (expired but correctly signed) token
  session goes straight to the start page, keeping `return_to`; so does any
  `/auth/google/login` when Google is not configured. The token login also
  clears `login_hint`, so no renewal is ever attempted for its browser.
- After signing in again, `return_to` brings the user back, as with Google.

## 3. http on the LAN: `COOKIE_SECURE`

- `COOKIE_SECURE=true` (default): every cookie cams sets (`session`,
  `return_to`, `oauth_state`, `login_hint`) is `Secure`, as today. The cluster
  keeps this.
- `COOKIE_SECURE=false`: the same cookies without `Secure`, so they work over
  `http://192.168.1.220:8080` (a browser drops a `Secure` cookie set over
  http, except on localhost). Startup logs a warning (`cookie_secure_off`).
- HSTS and other https-only headers: cams sets none itself (the cluster's
  ingress does), so there is nothing to switch off. **Ruling: no HSTS in the
  app, and a test that `COOKIE_SECURE=false` responses carry no
  `Strict-Transport-Security`** — why: an HSTS header seen once over http would
  be ignored, but adding one later in the app would break the Pi — cost if
  wrong: none today; the test guards the future.
- The same-origin check works unchanged: on the Pi there is no proxy in front,
  `req.protocol` is `http` and the browser's `Origin` is
  `http://192.168.1.220:8080`.

## 4. On the Pi

`docs/pi-demo.md`, `deploy/pi/compose.cams.yaml`,
`deploy/pi/cameras.example.json`:

- **Ruling: cams gets its own directory `/srv/cams` and compose project, not
  a service in cam-proxy's `compose.yaml`** — why: cam-proxy's compose file is
  that repo's file (its updates copy it over), and the two update on their own
  release cadences — cost if wrong: two `docker compose` commands instead of
  one.
- **Ruling: `network_mode: host`, `PORT=8080`** — why: cam-proxy runs with
  host networking and listens on `127.0.0.1:8480`; host networking lets cams
  reach it at `http://127.0.0.1:8480` without publishing anything new and
  shows the real client addresses to the rate limiter — cost if wrong: port
  8080 on the Pi must be free (cam-proxy uses 8480, 2121 and go2rtc's ports).
- The cameras file has the camera with `proxy.url http://127.0.0.1:8480`, the
  proxy's client token and admin token, and the camera's LAN address with the
  `cams` user for direct access (settings, light, fallback downloads).
- **Ruling: `CACHE_DIR` and `PREFS_FILE` on a bind mount `/srv/cams/data`,
  cache capped at 2 GiB** — why: preferences and the proxy switch state
  survive updates, and the SD card is shared with cam-proxy's recordings —
  cost if wrong: a smaller cache means more clip refetches from cam-proxy
  (same Pi, cheap).
- Changing addresses on the road: the camera's address lives in the cameras
  file (and in cam-proxy's own config); edit, then `docker compose restart`.
  The browser address is whatever the Pi has on that LAN; nothing in cams
  depends on it (no redirect URI, origin taken from the request).
- Updating: `docker compose pull && docker compose up -d` in `/srv/cams`.

## 5. Tests

- `test/loginConfig.test.ts`: the startup matrix (Google only, token only,
  both, neither, half Google, short token, token file, both token sources,
  bad `COOKIE_SECURE`, `CAMS_TOKEN_USER`).
- `test/tokenLogin.test.ts`: good/bad/missing/short/oversized token, JSON and
  form, the token in a query string, constant-time path (`timingSafeEqual`
  called with two 32-byte digests), the rate and failure limiters, CSRF
  (cross-origin 403), cookie flags with `COOKIE_SECURE` true/false (also for
  Google's cookies), no HSTS, `return_to`, allowlist bypass only for the token
  user and only for token sessions, token rotation, silent renewal skipped,
  Google routes when Google is off, the start page's meta tag per variant.
- `web/src/components/LoginOptions.svelte.test.ts`: the three page variants
  and the form's error messages.
- e2e: a second cams server on :8087 (`E2E_TOKEN_ENV`: token only, no Google,
  `COOKIE_SECURE=false`) and projects `token-desktop` / `token-phone` running
  `e2e/token-login.spec.ts`: the page shows only the token form; a wrong
  token shows the error; the right one opens the app at the remembered page;
  logout returns to the start page.
