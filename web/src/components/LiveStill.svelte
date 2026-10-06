<script lang="ts">
  import { untrack } from 'svelte';
  import { apiFetch } from '../lib/api';
  import { localClock as clock } from '../lib/clock';
  import { decideStill, keepPolling } from '../lib/liveConnectStill';
  // Plan 7: the camera gateway's newest still for Live while its video isn't
  // playing, marked as stills with the still's time and age. One request at a
  // time (a slow link still shows stills), drawn only once loaded; after a
  // failed load it hides and tries again after 5 s; nothing is asked for
  // while `active` is false (Live hidden). `onactive` tells Live whether
  // stills are showing (its header badge).
  // Klaus, 2026-10-06: `freshOnly` while live is connecting, before the 5 s
  // fallback: one request on connect, a still shown only when less than 60 s
  // old (its own time), and polled on only while one shows. Turning it off
  // (the fallback) neither asks again at once nor hides the still shown.
  let {
    cameraId,
    active = true,
    overlay = false,
    freshOnly = false,
    onactive,
  }: { cameraId: string; active?: boolean; overlay?: boolean; freshOnly?: boolean; onactive?: (on: boolean) => void } = $props();

  let shown = $state<{ url: string; at: number | null } | null>(null);
  let now = $state(Date.now());

  $effect(() => {
    if (!active) return;
    const id = cameraId;
    let loading = false;
    let failedAt = 0;
    let stopped = false;
    let asked = 0;
    let last: string | null = null;
    let lastAt: number | null = null;
    const show = (next: { url: string; at: number | null } | null) => {
      if (stopped) return;
      const was = shown !== null;
      shown = next;
      if (last) URL.revokeObjectURL(last);
      last = next?.url ?? null;
      lastAt = next?.at ?? null;
      if (was !== (next !== null)) onactive?.(next !== null);
    };
    const load = async () => {
      // A local time: reading the `now` state here would make this effect
      // depend on it and re-run every second.
      const t = Date.now();
      now = t;
      // untrack: the fallback taking over must not restart this effect.
      const fresh = untrack(() => freshOnly);
      if (loading || t - failedAt < 5000) return;
      if (!keepPolling({ freshOnly: fresh, asked, showing: last !== null })) return;
      loading = true;
      asked++;
      try {
        const res = await apiFetch(`/api/cameras/${encodeURIComponent(id)}/still/latest.jpg?t=${Date.now()}`);
        if (!res.ok) throw new Error(String(res.status));
        const header = Number(res.headers.get('X-Still-Time'));
        const at = Number.isFinite(header) && header > 0 ? header : null;
        const blob = await res.blob();
        if (stopped) return;
        const decision = decideStill({
          cameraId: untrack(() => cameraId),
          freshOnly: untrack(() => freshOnly),
          now: Date.now(),
          current: last ? { cameraId: id, at: lastAt } : null,
          next: { cameraId: id, at },
        });
        if (decision === 'show') show({ url: URL.createObjectURL(blob), at });
      } catch {
        failedAt = Date.now();
        show(null);
      } finally {
        loading = false;
      }
    };
    void load();
    const t = setInterval(() => void load(), 1000);
    return () => {
      clearInterval(t);
      show(null);
      stopped = true;
    };
  });

  const age = $derived(shown?.at ? Math.max(0, Math.round((now - shown.at) / 1000)) : null);
</script>

{#if shown}
  <figure class="still" class:overlay data-testid="live-still">
    <img src={shown.url} alt="The latest still from the camera gateway" />
    <span class="badge" data-testid="stills-badge" role="status">
      {shown.at ? `STILLS · ${clock(shown.at)} · ${age} s old` : 'STILLS'}
    </span>
    <figcaption>Live video isn't playing: showing stills from the camera gateway, one per second.</figcaption>
  </figure>
{/if}

<style>
  .still { margin: 0; display: grid; gap: 6px; position: relative; }
  /* Over the live player (Klaus, 2026-10-06): where the video will be, the
     same fit and background, so live takes over without anything moving.
     The connecting bar says what the caption says; it stays for screen
     readers. */
  .still.overlay { position: absolute; inset: 0; z-index: 2; display: block; background: var(--player-bg); }
  .still.overlay img { position: absolute; inset: 0; height: 100%; max-height: none; background: var(--player-bg); border-radius: 0; }
  .still.overlay figcaption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  img { width: 100%; max-height: 70vh; object-fit: contain; background: var(--bg); border-radius: var(--radius); }
  .badge {
    position: absolute; top: 14px; left: 14px; padding: 3px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
    background: var(--warning); color: var(--warning-ink);
  }
  .still:not(.overlay) .badge { top: 8px; left: 8px; }
  figcaption { font-size: 12px; color: var(--muted); }
</style>
