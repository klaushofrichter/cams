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
- [Ports and services](#ports-and-services)
- [Login and tokens](#login-and-tokens)
- [Token rejection: four shapes](#token-rejection-four-shapes)
- [Device information and time](#device-information-and-time)
- [Live video](#live-video)
- [Snapshots](#snapshots)
- [Recordings: Search](#recordings-search)
- [Recording file names](#recording-file-names)
- [Recordings: Download](#recordings-download)
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

The AI triggers only appear when the camera's AI **recording** schedule is on
(`GetRecV20` schedule keys `AI_PEOPLE`, `AI_VEHICLE`, `AI_DOG_CAT`). With only
`MD` on, every clip is motion-only.

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
