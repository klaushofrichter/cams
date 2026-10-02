# Recordings through cam-proxy's recordings API (design)

Status: approved by Klaus in chat, section by section (2026-10-02). This spec
is for review.

The cam-proxy API this uses (routes, query parameters, JSON shapes, status
codes, caching) is specified in cam-proxy's
`docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`, section 2,
"The recordings API". This spec covers only cams' part.

## Goal

For a camera with a cam-proxy, History's list, playback, the clip download and
the clip-based thumbnails come from the proxy's recordings API. The proxy
fetches SD-card recordings over Baichuan, which works while the camera's HTTP
`cmd=Download` refuses everything. Cameras without a proxy are unchanged.

## Background

- Since 2026-10-01 the RLC-1224A refuses every HTTP `cmd=Download`; the
  breaker in `server/recordings/service.ts` opens, and cams falls back to the
  proxy's FTP copies (`server/recordings/proxyClips.ts`), which are sub stream
  only and miss recordings when FTP was off (37 hours in September).
- cam-proxy gains `GET /api/cameras/:cam/recordings` (a list) and
  `GET /api/cameras/:cam/recordings/:id` (an MP4 with Range), fetched over
  Baichuan into the proxy's cache. Any SD recording of the last 7 days, in
  either stream.
- Order of work: phase 0 (done), cam-sim's Baichuan server and
  release, cam-proxy's client and API and release, then this.

## Design

### Route order for a camera with a cam-proxy (`proxyActive`)

**The day's list** (`RecordingsService.day()`):
1. The proxy: `GET /recordings?from=&to=&stream=sub` and `…&stream=main`,
   one after the other. `from`/`to` are the camera-local day's bounds in unix
   ms (from the camera's `timeInfo()`, as today). Entries are paired by start
   time exactly as today's two `searchDay()` results are: `id` goes through
   `parseClipName()` (it accepts a bare file name), `size` into
   `sizeSub`/`sizeMain`, and the `names` map holds the proxy ids.
2. On a proxy 502 or 503, or an unreachable proxy: the camera's own
   `searchDay()`, as today.

**The month list** (`days()`): the proxy's `GET /recordings/days?month=YYYY-MM`
(the days with recordings in that camera-local month), not the camera's
`searchMonth()`. The camera fails overlapping Searches by answering an empty
list without an error, and cams and the proxy are separate processes that
can't take turns; so for a proxied camera **every** camera Search goes
through the proxy, which runs one at a time. On a proxy 502 or 503, or an
unreachable proxy: the camera's own `searchMonth()`, as today (the proxy is
then not searching either). `extent.ts` reads events through `day()`, so it
follows.

**Playback and thumbnails from the clip** (`withClip()`, sub stream, cams'
disk cache as today):
1. `GET /recordings/:id` for the sub file, the whole file into cams' cache;
   cams then serves Range from its cache as today.
2. On a proxy 502 or 503, or an unreachable proxy: the proxy's FTP copy
   (`findProxyClip()`/`openProxyClip()`, today's path).
3. Then the camera's HTTP download behind the breaker (today's
   `downloadWithRetry()` in the transfer gate).

**The clip download** (`openDownload()`, `quality` sub or main, streamed
through, not cached, as today):
1. `GET /recordings/:id` for the chosen stream's file. The served filename
   keeps its `-sub`/`-main` suffix (it is the camera's file), not `-proxy`.
2. On a proxy 502 or 503, or an unreachable proxy: the proxy's FTP copy (named
   `-proxy.mp4`, as today).
3. Then the camera's HTTP download behind the breaker.

A proxy **404 `unknown_recording`** is final: cams answers `unknown_clip`, with
no fallback. A client abort is never retried on another route.

**Thumbnails.** Today's first step for a proxied camera stays: the proxy's
still 2 s into the event (`findProxyStill()`). When that fails, the thumbnail
is still made from the fetched file (`clipThumbnail()` → `withClip()`), which
now comes from the proxy's recordings API: still one transfer at a time per
camera (the proxy's queue), but fast (a sub file in well under a second).

**Concurrency.** Proxy requests stay outside cams' camera transfer slot, as
the FTP-copy path is today; the proxy queues its own Baichuan transfers (one at
a time per camera, a viewer first). The camera's HTTP fallback still takes the
slot.

### Code

- `server/recordings/proxyRecordings.ts` (new): `listProxyRecordings(cameraId,
  from, to, stream)` and `openProxyRecording(cameraId, id, signal)`, through the
  existing `ProxyClient` (`server/proxy/client.ts`), with the timeouts of
  `openProxyClip()` (30 s, 30 s idle). A 502 or 503 throws a `ProxyError` that
  `service.ts` treats as "fall back"; a 404 throws `RecordingError('unknown_clip')`.
- `server/recordings/service.ts`: the route order above in `day()`,
  `withClip()` and `openDownload()`; `downloadsState()`.
- `test/proxy/fakeProxy.ts` and `e2e/fakeProxyData.ts`: the two routes, so the
  fake stays in step with cam-proxy's client API (`CLAUDE.md`).

### `downloadsState`

It gains `proxy-recordings`:

| Value | When |
|---|---|
| `proxy-recordings` | the camera has a cam-proxy and its last recordings request didn't fail with 502/503 or a network error |
| `proxy` | the camera has a cam-proxy and its last recordings request failed: recordings come from FTP copies |
| `ok`, `unavailable` | cameras without a proxy, as today |

The web types (`web/src/lib/dayCache.ts`, `web/src/pages/Video.svelte`) gain the
value. The "Source of recordings and thumbnails" note reads "cam-proxy (SD
card)" for `proxy-recordings` and "cam-proxy (FTP copies)" for `proxy`.

### Cameras without a proxy

Unchanged: the camera's Search, its HTTP download, the breaker.

### Docs

`docs/reolink-api.md` ("Where cams handles each quirk") and the README
describe the route order: the proxy's recordings, then its FTP copy, then the
camera's HTTP download behind the breaker. CHANGELOG under `## [Unreleased]`.

## Error handling

- **Proxy 502/503 or unreachable**: the next route in the order above; logged
  at warn as `proxy_recordings_failed` with the camera, the clip id and the
  error code (never a token).
- **Proxy 404**: `unknown_clip` (the recording is gone from the SD card).
- **Proxy 400**: a bug in cams; logged at error, treated like 502 (falls back).
- **Every route failed**: the error of the last route, as today
  (`recordings_unavailable` when the breaker is open).
- **Failure mid-stream** in `openDownload()`: the response ends short, as with
  the camera's download today; no fallback once bytes were sent.
- **The breaker** counts camera refusals only; proxy failures never open it.

## Testing

**Unit** (vitest, the fake proxy):
- the list from the proxy, sub and main paired; the fallback to `searchDay()`
  on 502, 503 and an unreachable proxy;
- playback: proxy recordings first, then the FTP copy, then the camera, each
  step on 502/503; a 404 ends with `unknown_clip`; an abort doesn't fall back;
- the clip download for sub and main, and the filenames;
- thumbnails: the proxy still first, then the clip from the recordings API;
- `downloadsState`: `proxy-recordings`, `proxy` after a failure, back to
  `proxy-recordings` after a success; cameras without a proxy unchanged;
- the fake proxy's new routes match cam-proxy's shapes.

**e2e** (Playwright): cam-sim refuses HTTP Download (`downloads.refuse`),
cam-proxy fetches over Baichuan, cams plays the clip and downloads it in main.
cams' e2e has no real cam-proxy today (only the fake on :8095), so the plan
adds one: cam-proxy's container image or a release tarball, whichever the plan
finds workable, configured against the e2e cam-sim.

## Out of scope

- Gap-filling (#74 in cam-proxy) and restoring stills (#73).
- Moving the month list (`searchMonth()`) to the proxy.
- Changes for cameras without a proxy.
- UI beyond the source note.

## Phase 0 results that touch cams

Phase 0 (2026-10-02) is done; none of cams' design changes, because it follows
cam-proxy's API. For the record:

- The `proxy` camera user logs in over Baichuan. It stays admin level by
  Klaus's decision, so no other user is involved.
- The camera runs Baichuan transfers in parallel, so nothing else holding a
  "VOD session" blocks the proxy. Its one limit is 12 TCP connections on port
  9000, shared with other Baichuan clients. If that is ever exhausted, the
  proxy answers 502 (`refused`) and cams falls back to the FTP copies, as it
  does for any proxy 502.
- The proxy closes an idle Baichuan connection after 20 s and reconnects on
  demand, which cams never sees; a first download after a pause is about a
  second slower to start.

## References

- cam-proxy spec: `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`
  (cam-proxy repo), section 2 for the API.
- cam-sim spec: `docs/superpowers/specs/2026-10-02-baichuan-server-design.md`
  (cam-sim repo), for `downloads.refuse` and the Baichuan server.
- Findings: `~/Development/reolink/baichuan-download.md`.
- `docs/reolink-api.md`: Search, file names, Download.
