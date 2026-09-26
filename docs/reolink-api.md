# Reolink HTTP API: how it really behaves

This guide covers what cams relies on in the Reolink camera HTTP API. Everything
here was **measured against a real camera**, or read from the camera's own web
UI or the [`reolink_aio`](https://github.com/starkillerOG/reolink_aio) library
that Home Assistant uses. Where the firmware differs from what you would
expect, the guide says so. Several of these differences caused production bugs
in cams.

| | |
|---|---|
| Camera | Reolink **RLC-1224A** (12 MP turret), hardware `IPC_NT18NA612MP` |
| Firmware | **v3.2.0.6011_2607012059** |
| Measured | **2026-09-25 and 2026-09-26** |
| Web UI | version 2.1.0 (`https://<camera>/`) |

Other models or firmware versions may behave differently. When a quirk turns
up, change the mock camera (`test/mock-camera/server.ts`) to reproduce it
**before** fixing the client. A mock that copies the documentation instead of
the firmware hid most of the bugs listed here.

## Contents

- [Basics](#basics)
- [Camera authentication](#camera-authentication)
- [DNS, the camera's name and its certificate](#dns-the-cameras-name-and-its-certificate)
- [Ports and services](#ports-and-services)
- [Login and tokens](#login-and-tokens)
- [Token rejection: four shapes](#token-rejection-four-shapes)
- [Device information and time](#device-information-and-time)
- [Live video](#live-video)
- [Snapshots](#snapshots)
- [Recordings: Search](#recordings-search)
- [Recording file names](#recording-file-names)
- [Recordings: Download](#recordings-download)
- [Settings](#settings)
- [Certificates](#certificates)
- [Where cams handles each quirk](#where-cams-handles-each-quirk)

## Basics

All JSON commands are `POST /cgi-bin/api.cgi?cmd=<Cmd>&token=<token>` with a
JSON **array** body. The reply is an array in the same order:

```json
[{ "cmd": "GetDevInfo", "action": 0, "param": {} }]
```

```json
[{ "cmd": "GetDevInfo", "code": 0, "value": { "DevInfo": { "model": "RLC-1224A", "firmVer": "v3.2.0.6011_2607012059" } } }]
```

On failure, `code` is non-zero and `error.rspCode` is negative:

```json
[{ "cmd": "Search", "code": 1, "error": { "rspCode": -54, "detail": "the respode of msg is err" } }]
```

The examples below assume these shell variables. Keep the password out of your
shell history and out of logs: read it from a file and never echo it.

```sh
export CAM=192.168.1.164                # the camera's LAN address
set -a; . ~/Development/reolink/.env; set +a   # provides REOLINK_PASSWORD
```

The camera serves a certificate for `cam1.skylar.technology`. When you connect
by IP, either pass `--resolve cam1.skylar.technology:443:$CAM` and use that
name, or use `-k` for quick local tests. In Node, set
`servername: 'cam1.skylar.technology'` on the TLS options; the name check then
uses the servername.

## Camera authentication

This section is about logging in **to the camera**. The cams app's own Google
sign-in is separate.

**Users.** The camera has its own user list (`GetUser`), each with a level of
`admin` or `guest`. `AddUser` and `DelUser` manage them:

```json
[{ "cmd": "AddUser", "action": 0, "param": { "User": { "userName": "cams", "password": "…", "level": "admin" } } }]
```

| User | Level | Used by | Password kept in |
|---|---|---|---|
| `admin` | admin | the owner: camera web UI, Reolink app, setup scripts | `~/Development/reolink/.env` (`REOLINK_PASSWORD`) only |
| `cams` | admin | the cams app | Kubernetes Secret `cams-cameras` (namespace `cams`) only |

- The `cams` user exists so the owner's password never leaves `.env`.
  `scripts/create-camera-user.sh` creates it:
  1. It generates a random 24-character password.
  2. It verifies that the new password can log in.
  3. It writes the Secret.

  The script never prints the password. It refuses to touch an existing `cams`
  user unless you pass `--reset`. After a reset it restarts the cams pod,
  because the pod reads the password only at startup.
- A second `admin`-level user can do everything cams needs: device info, Snap,
  FLV live, Search, Download. `guest` has not been tested.
- The certificate CronJob in the cluster uses its own Secret,
  `cam1-camera-credentials` (namespace `cam1`), created by
  `~/Development/reolink/create-cam-secret.sh`.

**Sessions.** `Login` returns a token that is valid for `leaseTime` (3600 s).
Every other request carries it as `token=` in the query string. This is the
firmware's design; there is no header alternative. So:

- **Never log camera URLs.** They contain a live token. cams logs only error
  codes, never request URLs.
- **Never put the password in a URL.** `user=…&password=…` query
  authentication exists for some GET endpoints, but Download answers it with
  404, and a URL with a password ends up in logs and shell history. cams
  always uses the token.
- Sessions are limited on the camera. `GetOnline` lists them, e.g.
  `[cams, admin, admin]`. Reuse one token per client and `Logout` when done.
  Tokens that are never logged out expire after the lease.
- Changing a user's password, or rebooting the camera, invalidates its tokens.
  Clients then see the [token rejection shapes](#token-rejection-four-shapes).

**The camera's web UI** is at `https://<camera IP>/` (e.g.
`https://192.168.1.164/`).

> **The camera's web UI is reachable from the home network only, by design**
> (decided 2026-09-26). The public name `cam1.skylar.technology` does **not**
> lead to it: from anywhere, including the home network, it answers
> `404` from the cluster with Traefik's default certificate. The camera's admin
> page is protected only by its own password, and consumer camera firmware has a
> history of security holes, so it is not exposed to the internet. The cams
> app's "Camera web UI" link points at the LAN address and says so. Remote
> access to the camera goes through the cams app (Google sign-in) or the
> Reolink mobile app. Log in as `admin`.
The browser warns about the certificate, because it is issued for
`cam1.skylar.technology`, not for the IP address (see the next section).

## DNS, the camera's name and its certificate

The camera has a public name, but **that name does not lead to the camera**.
It exists only so the camera can have a trusted certificate.

```
cam1.skylar.technology ──DNS (Squarespace)──▶ home public IP ──router :80/:443──▶ k3s cluster (Traefik)
                                                                                      │
        camera 192.168.1.164 ◀── ImportCertificate (daily CronJob) ◀── cert-manager (Let's Encrypt, HTTP-01)
```

- **DNS.** `cam1.skylar.technology` is an A record at the domain's DNS
  provider (Squarespace, no API) pointing at the home's public IP. The ASUS
  router forwards ports 80 and 443 to the Kubernetes cluster, not to the
  camera.
- **Certificate.** cert-manager in the cluster (namespace `cam1`) gets a
  Let's Encrypt certificate for that name through the HTTP-01 challenge,
  which the cluster answers. The CronJob `cam1-cert-push` then installs it on
  the camera daily at 04:17 America/Chicago:
  1. It calls `CertificateClear`, because an import over an existing
     certificate is silently ignored.
  2. It waits and logs in again.
  3. It calls `ImportCertificate`.

  Grafana alerts fire if the push goes stale or the certificate stops renewing.
- **Nothing routes the name to the camera.** The cluster serves only the
  ACME challenge for `cam1.skylar.technology`; any other request gets `404`
  with Traefik's default certificate. That is deliberate: see
  [Camera authentication](#camera-authentication).
- **No LAN DNS override.** On the home network, `cam1.skylar.technology` still
  resolves to the public IP, i.e. to the cluster. The stock ASUS firmware has no
  custom DNS entries, and none was added on purpose. So **every client reaches
  the camera by IP** and checks the certificate against the name:
  - **Node** (cams): `host: '192.168.1.164'` with TLS
    `servername: 'cam1.skylar.technology'`. This is `tlsServername` in the
    cams camera config; the name check uses the servername.
  - **curl:**
    ```sh
    curl --resolve cam1.skylar.technology:443:192.168.1.164 https://cam1.skylar.technology/cgi-bin/api.cgi?cmd=Login …
    ```
  - **Browser:** by IP, so expect a certificate warning.
- **The Reolink mobile app** doesn't use any of this. It talks to the camera
  over Reolink's own protocol (port 9000) or the Reolink cloud relay.
- **The IP address is configuration.** The camera gets its address by DHCP,
  with no reservation as of 2026-09-26. If the address changes, cams and the
  certificate CronJob lose the camera. They store `192.168.1.164` in the
  Secrets `cams-cameras` and `cam1-camera-credentials`. A DHCP reservation on
  the router would prevent that.

## Ports and services

Settings → Network → Advanced → Server Settings. Several services are **off by
default**, and features quietly depend on them:

| Service | Port | Needed for | Symptom when off |
|---|---|---|---|
| HTTPS | 443 | the API | nothing works |
| **HTTP** | 80 | recording `Download`, **even when requested over HTTPS** | `Download` drops the connection; Snap and FLV keep working |
| **RTMP** | 1935 | HTTPS FLV live, and Download (proxied internally) | the connection closes with no reply |
| RTSP | 554 | `rtsp://…/h264Preview_01_main` / `_sub` | port refused |
| ONVIF | 8000 | standards clients | — |

Port 9000 carries Reolink's own "Baichuan" protocol. The mobile app uses it,
and it stays open regardless of these settings.

Check the current settings:

```sh
curl -sk -X POST "https://$CAM/cgi-bin/api.cgi?cmd=GetNetPort&token=$TOKEN" \
  -d '[{"cmd":"GetNetPort","action":0,"param":{}}]'
# → {"NetPort":{"httpEnable":1,"httpPort":80,"httpsEnable":1,"rtmpEnable":1,"rtspEnable":1,...}}
```

## Login and tokens

```sh
TOKEN=$(python3 - <<'PY'
import json, os, ssl, urllib.request
body = json.dumps([{"cmd": "Login", "action": 0, "param": {"User": {
    "Version": "0", "userName": "admin", "password": os.environ["REOLINK_PASSWORD"]}}}]).encode()
req = urllib.request.Request(f"https://{os.environ['CAM']}/cgi-bin/api.cgi?cmd=Login", body,
                             {"Content-Type": "application/json"})
ctx = ssl._create_unverified_context()
print(json.load(urllib.request.urlopen(req, context=ctx))[0]["value"]["Token"]["name"])
PY
)
```

(Export `CAM` first for this snippet.) The reply carries
`value.Token.leaseTime: 3600`, i.e. seconds.

- **Sessions are a limited resource.** Reuse one token per camera. Log in
  again only when the lease is about to end or the camera rejects the token.
  `GetOnline` lists open sessions. `Logout` ends one.
- cams renews 60 s before the lease ends, logs in single-flight, and backs off
  30 s after a failed login (`server/reolink/client.ts`).
- cams uses its own admin user, `cams`, created by
  `scripts/create-camera-user.sh`, so the owner's password never leaves `.env`.

## Token rejection: four shapes

A camera reboot invalidates every token. The firmware reports an invalid token
**differently per endpoint**. A client must recognise all four shapes, log in
again once, and retry.

| Endpoint | Rejection |
|---|---|
| JSON commands (`POST`) | `code: 1`, `rspCode: -6` ("please login first") |
| `GET ?cmd=Snap` | **HTTP 200**, `Content-Type: text/html`, body is the `-6` JSON |
| `GET /flv?…` | **no HTTP response**: the connection is reset (`ECONNRESET`, "socket hang up", curl "Empty reply") |
| `GET ?cmd=Download` | **HTTP 401**, `text/html`, empty body |

For `/flv`, a reset can also mean "the camera is busy". cams re-checks the
token with `GetDevInfo` before retrying, so it doesn't log in again for
nothing.

## Device information and time

```sh
# post <Cmd> [param-json]
post() { local param=${2:-'{}'}; curl -sk -X POST "https://$CAM/cgi-bin/api.cgi?cmd=$1&token=$TOKEN" \
  -d "[{\"cmd\":\"$1\",\"action\":0,\"param\":$param}]"; }
post GetDevInfo     # model, firmVer, hardVer, name, serial
post GetTime        # clock, timezone, DST
post GetHddInfo     # SD card: capacity/size (MB), mount, format
post GetEnc         # stream parameters
post GetRecV20 '{"channel":0}'   # recording settings: saveDay, postRec, preRec, schedule
```

`GetTime` returns:

```json
{ "Time": { "timeZone": 21600, "isDst": 1, "year": 2026, "mon": 9, "day": 25, "hour": 23, "min": 41 },
  "Dst": { "enable": 1, "offset": 1 } }
```

- **`timeZone` is in seconds west of UTC.** 21600 means UTC−6 (America/Chicago
  standard time).
- `Dst.offset` is in **hours**.
- A clip's UTC offset in minutes is `−timeZone/60 + (DST flag in the file name ? Dst.offset × 60 : 0)`.
  For Chicago in summer that is −300, i.e. `-05:00`.

Streams (`GetEnc`):
- **main:** H.265, 4512×2512 @ 20 fps, 8 Mbit/s
- **sub:** H.264, 896×512 @ 10 fps, 1 Mbit/s

Both streams carry AAC audio.

## Live video

```
GET /flv?port=1935&app=bcs&stream=channel0_<sub|main>.bcs&token=<t>
```

This returns an endless `video/x-flv` response and needs RTMP enabled.

- **sub** is standard H.264 + AAC. It plays in any browser through MSE, e.g. with
  mpegts.js.
- **main** is H.265 in FLV with the **legacy codec id 12**, a vendor extension
  that is not in the FLV spec. ffprobe can't read it. mpegts.js 1.8+ can, and the
  browser needs HEVC in MSE (Chrome or Safari on macOS).
- Many concurrent streams overload the camera. cams opens at most 4 per camera
  and shares them through its server.

## Snapshots

```sh
curl -sk "https://$CAM/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=$RANDOM&token=$TOKEN" -o snap.jpg
```

This returns a full-resolution JPEG (4512×2512, about 700 KB) in about a second.
`rs` is any random string, used as a cache buster.

## Recordings: Search

Recording is **event-triggered**, not continuous. A clip runs from a short
pre-record through the motion, plus a 15 s post-record. Measured lengths are
3–49 s. Clips are kept for `saveDay` days (7 here), and every clip exists on
both streams.

**Days with recordings in a month** (`onlyStatus: 1`):

```sh
post Search '{"Search":{"channel":0,"onlyStatus":1,"streamType":"main",
  "StartTime":{"year":2026,"mon":9,"day":1,"hour":0,"min":0,"sec":0},
  "EndTime":{"year":2026,"mon":9,"day":30,"hour":23,"min":59,"sec":59}}}'
# → {"SearchResult":{"Status":[{"year":2026,"mon":9,"table":"000000000000000000000000110000"}]}}
```

`table` has one character per day of the month (index 0 is day 1). `1` means
that day has recordings.

**Clips of one day** (`onlyStatus: 0`):

```sh
post Search '{"Search":{"channel":0,"onlyStatus":0,"streamType":"sub",
  "StartTime":{"year":2026,"mon":9,"day":26,"hour":0,"min":0,"sec":0},
  "EndTime":{"year":2026,"mon":9,"day":26,"hour":23,"min":59,"sec":59}}}'
```

```json
{ "SearchResult": { "File": [ {
  "name": "/mnt/sda/Mp4Record/2026-09-26/RecS0A_DST20260926_065221_065224_0_55148080000000_4AC87.mp4",
  "size": "306343", "type": "sub",
  "StartTime": { "hour": 6, "min": 52, "sec": 21, "...": "..." },
  "EndTime":   { "hour": 6, "min": 52, "sec": 24, "...": "..." } } ] } }
```

Quirks:

> **One Search at a time.** A Search that overlaps another fails with
> `rspCode -54` ("the respode of msg is err"). Worse, the other overlapping
> Search can come back with **no files and no error**. Serialize every Search
> per camera. In cams, parallel sub and main searches broke the recordings list
> in production.

- **`size` is a string.**
- **A day with no clips has no `File` key**, rather than an empty array.
- **The sub and main copies of one event can end a few seconds apart.** For
  example, sub ends `065224` and main ends `065226` for an event that starts
  `065221`. Pair the two copies by **start time**, and use the later end.
- **A clip still being recorded** is listed with end time `000000`, e.g.
  `…_072758_000000_…`. Its real end appears once recording stops. Only a clip
  that starts just before midnight can really end at `000000`.
- Two events close together become two overlapping clips, not one merged
  event: `072738_072800` and `072758_072844`.

## Recording file names

```
/mnt/sda/Mp4Record/2026-09-26/RecS0A_DST20260926_065221_065224_0_55148080000000_4AC87.mp4
                               │  │  │  │        │      │      │ │              └ size (hex)
                               │  │  │  │        │      │      │ └ flags (14 hex digits)
                               │  │  │  │        │      │      └ animal type (optional)
                               │  │  │  │        │      └ end   HHMMSS (camera-local)
                               │  │  │  │        └ start HHMMSS (camera-local)
                               │  │  │  └ date YYYYMMDD (camera-local)
                               │  │  └ present when DST was active → decides the UTC offset
                               │  └ name version (0A = 10)
                               └ M = main stream, S = sub stream
```

**Trigger flags** (name versions 9 and 10, 14 hex digits, layout from
`reolink_aio`): test bit `55 − pos` of the flags value, where `pos` is:

| Trigger | pos | Example flags |
|---|---|---|
| person | 17 | `5514C000000000` |
| vehicle | 19 | `55149000000000` |
| pet (dog/cat) | 20 | `55148800000000` |
| schedule (timer) | 23 | — |
| motion | 24 | `55148080000000` (real sub clip), `7B288280000000` (real main clip) |

```ts
// server/recordings/clipNames.ts
const POSITIONS = [['person', 17], ['vehicle', 19], ['pet', 20], ['timer', 23], ['motion', 24]] as const;

function decodeTriggers(flagsHex: string): string[] {
  if (!/^[0-9A-F]{14}$/i.test(flagsHex)) return [];
  const value = BigInt(`0x${flagsHex}`);
  return POSITIONS.filter(([, pos]) => ((value >> BigInt(55 - pos)) & 1n) === 1n).map(([t]) => t);
}

decodeTriggers('55148080000000'); // ['motion']
decodeTriggers('5514D080000000'); // ['person', 'vehicle', 'motion']
```

AI triggers appear only when the camera's AI **recording** schedule is on
(`GetRecV20` schedule keys `AI_PEOPLE`, `AI_VEHICLE`, `AI_DOG_CAT`) and AI
detection fires. On this camera the schedule is fully on, and every clip so
far is still motion-only.

## Recordings: Download

```
GET /cgi-bin/api.cgi?cmd=Download&source=<full name>&output=<file>.mp4&token=<t>
```

This returns `200 video/mp4`: a fragmented MP4 (it starts with `ftyp mp42`)
that a browser `<video>` element can seek directly. The byte count differs
from the Search `size`, because the camera remuxes on the fly.

> **Send `source` unencoded.** The path must keep its plain slashes
> (`source=/mnt/sda/Mp4Record/…`). A percent-encoded path (`%2F`) makes the
> camera **drop the connection with no response**, which looks exactly like a
> dead camera. The camera's own web UI (`js/ControllerDownload.js`) sends it
> raw. In cams, `encodeURIComponent` broke all clip playback in production.
> Validate the name against a safe pattern instead of encoding it:
> `^[A-Za-z0-9_./-]+\.mp4$`.

```sh
NAME=/mnt/sda/Mp4Record/2026-09-26/RecS0A_DST20260926_065221_065224_0_55148080000000_4AC87.mp4
curl -sk "https://$CAM/cgi-bin/api.cgi?cmd=Download&source=$NAME&output=$(basename $NAME)&token=$TOKEN" -o clip.mp4
```

```ts
// server/reolink/client.ts: the name comes from the camera's own Search,
// and is checked, not encoded.
const SAFE_RECORDING_NAME = /^[A-Za-z0-9_./-]+\.mp4$/;
if (!SAFE_RECORDING_NAME.test(name)) throw new CameraError('camera_error', 'unexpected recording name');
const base = name.slice(name.lastIndexOf('/') + 1);
const path = `/cgi-bin/api.cgi?cmd=Download&source=${name}&output=${base}&token=${token}`;
```

More quirks:

- **One download at a time.** The web UI first calls
  `CheckDownload {"filename": "<name>"}`, which replies `{"downloadTask": 0}`,
  and refuses to start a second download while `downloadTask >= 1`. After
  overlapping downloads, the camera refused *every* download.
- **It is slow**, about **150 KB/s**. A ~600 KB sub clip takes ~15 s, and a
  15 MB main clip ~100 s. Put user-initiated playback ahead of background work
  such as thumbnails.
- **It occasionally resets** a Download that succeeds when retried a moment
  later. Retry once.
- **When the camera is wedged:**
  - Every Download resets, over HTTPS and HTTP alike, even with the admin
    account.
  - The web UI's Playback page shows only a spinner.
  - An API `Reboot` does **not** fix it. A **power cycle** does.
- **Other forms fail differently**, which is useful when debugging:

  | Request | Result |
  |---|---|
  | token and **encoded** `source` | connection reset |
  | `user=…&password=…` instead of a token | **404**, `text/html` |
  | `cmd=Playback&source=…` | **404** |
  | `cmd=download` (lowercase), raw `source` | works, same as `Download` |
  | a bad or expired token | **401**, `text/html`, empty body |

- The web UI also appends an `encrypt=` parameter to requests, an obfuscated
  `countId`/`checkNum` counter. The API works without it.

## Settings

These were measured on 2026-09-26 by writing back the current value of each setting and re-reading it; nothing changed.
- Every Set command accepts **partial parameters**, and answers `code 0, rspCode 200`.
- Invalid values are rejected and the old value stays:
  - `SetMdAlarm` with `sensDef: 99` → `rspCode -56`;
  - `SetIsp` with `dayNight: "Purple"` → `rspCode -67`.
- **A `200` doesn't prove the write took effect** (see `ImportCertificate`). Re-read after every write.

| Setting | Read | Write | Values |
|---|---|---|---|
| Recording on/off | `GetRecV20 {channel:0}` → `Rec.enable` | `SetRecV20 {Rec:{enable}}` | 0/1 |
| Record on motion / AI type | `Rec.schedule.table.MD`, `AI_PEOPLE`, `AI_VEHICLE`, `AI_DOG_CAT` (168 chars, one per hour of the week) | `SetRecV20 {Rec:{schedule:{channel:0,table:{AI_PEOPLE:"1"×168}}}}` (only that key is written) | all `1` on, all `0` off, mixed = a custom schedule |
| Motion sensitivity | `GetMdAlarm {channel:0}` → `MdAlarm.newSens.sensDef` (`useNewSens: 1`) | `SetMdAlarm {MdAlarm:{channel:0,useNewSens:1,newSens:{sensDef}}}` | 1–50, **lower = more sensitive**; shown as `51 − sensDef` |
| AI sensitivity | `GetAiAlarm {channel:0,ai_type}` → `AiAlarm.sensitivity` | `SetAiAlarm {AiAlarm:{channel:0,ai_type,sensitivity}}` | 0–100; `people`, `vehicle`, `dog_cat` |
| Day/night | `GetIsp` → `Isp.dayNight` | `SetIsp {Isp:{channel:0,dayNight}}` | `Auto`, `Color`, `Black&White` |
| IR lights | `GetIrLights` → `IrLights.state` | `SetIrLights {IrLights:{channel:0,state}}` | `Auto`, `Off` |
| Spotlight | `GetWhiteLed` → `WhiteLed.mode`, `bright` | `SetWhiteLed {WhiteLed:{channel:0,mode,bright}}` | mode 0 off, 1 on motion at night, 2 on at night, 3 schedule; bright 0–100 |
| On-screen text | `GetOsd` → `Osd.osdChannel {enable,name,pos}`, `Osd.osdTime {enable,pos}` | `SetOsd {Osd:{channel:0,osdChannel:{…},osdTime:{…}}}` | 6 positions (`Upper Left` … `Lower Right`); name ≤ 31 bytes (cams: UTF-8 bytes, no control or format characters) |
| Storage | `GetHddInfo` → `HddInfo[0] {capacity, size, mount}` | — | MB; **`size` is the FREE space** |
| Certificate | TLS handshake (`getPeerCertificate()`) | — | `GetCertificateInfo` has no subject or expiry |
| Reboot | — | `Reboot {}` | the camera is offline about a minute; it may drop the connection before answering |

Rules cams follows:
- **Partial writes are built from the raw reply.** When only part of an object changes (e.g. the OSD name), cams takes the other keys from the camera's own reply, never from a normalised copy. A value cams doesn't recognise, such as a custom OSD position, is sent back unchanged instead of being replaced by a default.
- **Unmodelled keys are never sent.** Keys cams doesn't model (`LightingSchedule`, `watermark`, …) are left alone, relying on the firmware's partial-parameter merge.
- **The AI record schedule on this camera is fully on** (168 × `1` for people, vehicles and pets). The clips so far are motion-only only because AI detection hasn't fired.

## Certificates

- `GetCertificateInfo` returns `{crtName, keyName, enable}`. `enable` is 1 once
  a custom certificate is installed. The factory certificate is self-signed
  (`CN=CERTIFICATE`).
- `ImportCertificate` takes
  `{"importCertificate":{"crt":{"size":…,"name":"server.crt","content":"<base64 PEM>"},"key":{…,"name":"server.key"}}}`.
  `size` is the raw byte length. Use an RSA key.
- **Importing over an existing certificate returns `rspCode 200` and changes
  nothing.** Run `CertificateClear` first, wait about 10 s, log in again, then
  import. The `cam1-cert-push` CronJob in the cluster does this daily.

## Where cams handles each quirk

| Quirk | Code | Mock (`test/mock-camera/server.ts`) |
|---|---|---|
| Token rejection shapes (−6, Snap 200/html, FLV reset, Download 401) | `isAuthRejection`, `getWithToken`, `revalidateAfterReset` in `server/reolink/client.ts` | each shape reproduced |
| One Search at a time (−54) | `searchGate` in `server/reolink/client.ts` | a concurrent Search gets −54 |
| Unencoded Download `source` | `download()` in `server/reolink/client.ts` | an encoded `source` resets the connection |
| One transfer at a time, playback ahead of thumbnails | `PriorityGate` (`server/recordings/priorityGate.ts`), `TRANSFERS_PER_CAMERA` in `server/recordings/service.ts` | download order recorded in `state.downloadOrder` |
| Occasional Download reset | `downloadWithRetry` in `server/recordings/service.ts` | `dropFirstDownloads` |
| Sub/main ends differ; still-recording `000000` | `day()` / `isStillRecording` in `server/recordings/service.ts` | `mainEnd` on `MockClip`; an end of `000000` |
| File names, triggers, DST offset | `server/recordings/clipNames.ts` | names built the same way |

The Obsidian note **Cameras/Reolink API Behaviour** carries the same facts, for
use outside this repository.
