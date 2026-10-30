<script lang="ts">
  import { flip } from 'svelte/animate';
  import Icon from './Icon.svelte';
  import { persistedBoolean } from '../lib/stores';
  import { duration, reveal } from '../lib/motion';
  import { eventStream } from '../lib/eventStream';
  import { checkPositionName, defaultPositionName, moveId, ptzApi, ptzErrorText, type Direction, type PtzCapabilities, type PtzPosition } from '../lib/ptz';
  import { createHold, type Hold } from '../lib/ptzHold';

  // The PTZ panel (cam-proxy spec 2026-10-30-ptz-capabilities-design §8.2):
  // on the Video page for a pan/tilt camera, live only. Collapsed until
  // opened (remembered per browser). A tap on the pad is one short step, a
  // hold keeps moving until let go; whatever ends a hold (leaving the button,
  // the tab hidden, the window losing focus, another camera, the page going
  // away) stops the camera it moved.
  let { cameraId, ptz }: { cameraId: string; ptz: PtzCapabilities } = $props();

  const open = persistedBoolean('cams-ptz-open', false);
  let error = $state('');

  // The pad, row by row; null: the empty centre. The arrow icon points right
  // and is turned to each direction.
  const PAD: (Direction | null)[] = ['left-up', 'up', 'right-up', 'left', null, 'right', 'left-down', 'down', 'right-down'];
  const TURN: Record<Direction, number> = { right: 0, 'right-down': 45, down: 90, 'left-down': 135, left: 180, 'left-up': 225, up: 270, 'right-up': 315 };
  const label = (d: Direction) => `Move ${d.split('-').reverse().join('-')}`;

  type Key = `dir-${Direction}` | 'zoom-in' | 'zoom-out' | 'focus-near' | 'focus-far';
  // One Hold per button, for the camera shown; replaced (and every running
  // hold stopped, on its own camera) when the camera changes or the panel goes.
  let holds = new Map<Key, Hold>();
  $effect(() => {
    const cam = cameraId;
    const api = ptzApi(cam);
    const mine = () => cam === cameraId;
    const make = (start: (ms: number) => Promise<void>) =>
      createHold({
        start: (ms) => start(ms).then(() => { if (mine()) error = ''; }),
        stop: api.stop,
        onError: (e) => { if (mine()) error = ptzErrorText(e); },
      });
    const next = new Map<Key, Hold>();
    for (const d of PAD) if (d) next.set(`dir-${d}`, make((ms) => api.move(d, ms)));
    next.set('zoom-in', make((ms) => api.zoom('in', ms)));
    next.set('zoom-out', make((ms) => api.zoom('out', ms)));
    next.set('focus-near', make((ms) => api.focus('near', ms)));
    next.set('focus-far', make((ms) => api.focus('far', ms)));
    holds = next;
    error = '';
    renaming = confirming = null;
    saving = false;
    return () => {
      for (const h of next.values()) h.cancel();
    };
  });

  const cancelAll = () => {
    for (const h of holds.values()) h.cancel();
  };
  $effect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') cancelAll();
    };
    window.addEventListener('blur', cancelAll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', cancelAll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  // --- saved positions (spec §5.2) -----------------------------------------
  // Loaded while the panel is open (and again on opening), reloaded on the
  // proxy's ptz-positions message and after each own change. A reload keeps
  // the rows on screen; only the very first load says "Loading positions…".
  let positions = $state<PtzPosition[] | null>(null);
  let max = $state(20);
  let loadedFor = '';
  let loadSeq = 0;
  const api = $derived(ptzApi(cameraId));

  async function load(): Promise<void> {
    const cam = cameraId;
    const seq = ++loadSeq;
    try {
      const r = await ptzApi(cam).positions();
      if (seq !== loadSeq || cam !== cameraId) return;
      positions = [...r.positions].sort((a, b) => a.order - b.order);
      max = r.max;
    } catch (e) {
      if (seq === loadSeq && cam === cameraId) error = ptzErrorText(e);
    }
  }

  $effect(() => {
    const cam = cameraId;
    if (!$open || !ptz.positions) return;
    if (loadedFor !== cam) {
      positions = null; // another camera's list is not this one's
      loadedFor = cam;
    }
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = eventStream()?.onPtzPositions((c) => {
      if (c !== cam) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    });
    return () => {
      clearTimeout(timer);
      off?.();
    };
  });

  // One change at a time from this panel; errors in the panel's one line.
  let busy = $state(false);
  async function change(run: () => Promise<unknown>, after?: () => void): Promise<boolean> {
    busy = true;
    try {
      await run();
      error = '';
      after?.();
      return true;
    } catch (e) {
      error = ptzErrorText(e);
      return false;
    } finally {
      busy = false;
      await load();
    }
  }

  const go = (p: PtzPosition) => void change(() => api.go(p.id));
  const makeHome = (p: PtzPosition) => void change(() => api.makeHome(p.id));
  const resave = (p: PtzPosition) => void change(() => api.resave(p.id));

  // Sorting (↑↓ and drop): the list moves at once; a refusal reloads it.
  function reorder(from: number, to: number) {
    if (!positions || from === to || to < 0 || to >= positions.length) return;
    const ids = moveId(positions.map((p) => p.id), from, to);
    const byId = new Map(positions.map((p) => [p.id, p]));
    positions = ids.map((id, order) => ({ ...byId.get(id)!, order }));
    void change(() => api.order(ids));
  }
  let dragging = $state<string | null>(null);
  let dropOn = $state<string | null>(null);
  function drop(onId: string) {
    const list = positions ?? [];
    const from = list.findIndex((p) => p.id === dragging);
    const to = list.findIndex((p) => p.id === onId);
    dragging = dropOn = null;
    if (from >= 0 && to >= 0) reorder(from, to);
  }

  // Inline rename: one row at a time.
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let renameProblem = $state('');
  function startRename(p: PtzPosition) {
    confirming = null;
    renaming = p.id;
    renameValue = p.name;
    renameProblem = '';
  }
  async function saveRename(p: PtzPosition) {
    if (renameValue.trim() === p.name) return void (renaming = null);
    const problem = checkPositionName(renameValue, positions ?? [], p.id);
    if (problem) return void (renameProblem = problem);
    const name = renameValue.trim();
    if (await change(() => api.rename(p.id, name))) renaming = null;
  }
  function renameKeys(e: KeyboardEvent, p: PtzPosition) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveRename(p);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      renaming = null;
    }
  }

  // Inline delete: a confirm row in place of the row (no browser dialog).
  let confirming = $state<string | null>(null);
  const homeBlocked = (p: PtzPosition) => p.home && (positions?.length ?? 0) > 1;
  async function remove(p: PtzPosition) {
    if (await change(() => api.remove(p.id))) confirming = null;
  }

  // Save position: an inline name field.
  let saving = $state(false);
  let saveValue = $state('');
  let saveProblem = $state('');
  const full = $derived(!!positions && positions.length >= max);
  function startSave() {
    saving = true;
    saveValue = defaultPositionName(positions ?? []);
    saveProblem = '';
  }
  async function submitSave() {
    const problem = checkPositionName(saveValue, positions ?? []);
    if (problem) return void (saveProblem = problem);
    const name = saveValue.trim();
    if (await change(() => api.save(name))) saving = false;
  }
  function saveKeys(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      saving = false;
    }
  }
  // Focus the field an inline editor opens with, its text selected.
  const focusSelect = (el: HTMLInputElement) => {
    el.focus();
    el.select();
  };

  // Pointer and keyboard on one button.
  function press(key: Key) {
    return {
      onpointerdown: (e: PointerEvent) => {
        if (e.button !== 0) return;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        } catch {
          // no capture (an old browser, a synthetic event): pointerleave ends it
        }
        holds.get(key)?.press();
      },
      onpointerup: () => holds.get(key)?.release(),
      onpointerleave: () => holds.get(key)?.cancel(),
      onpointercancel: () => holds.get(key)?.cancel(),
      onlostpointercapture: () => holds.get(key)?.cancel(),
      onblur: () => holds.get(key)?.cancel(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!e.repeat) holds.get(key)?.press();
      },
      onkeyup: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') holds.get(key)?.release();
      },
      oncontextmenu: (e: Event) => e.preventDefault(),
    };
  }
</script>

<section class="tile ptz" data-testid="ptz-panel">
  <button class="head" data-testid="ptz-toggle" aria-expanded={$open} aria-controls="ptz-body" onclick={() => open.set(!$open)}>
    <span class="title">Pan &amp; tilt</span>
    <span class="chev" class:open={$open}><Icon name="chevron" size={16} /></span>
  </button>
  {#if $open}
    <div class="body" id="ptz-body" data-testid="ptz-body" transition:reveal>
      <div class="controls">
        {#if ptz.move}
          <div class="pad" role="group" aria-label="Direction">
            {#each PAD as d, i (d ?? `centre-${i}`)}
              {#if d}
                <button class="key" data-testid={`ptz-dir-${d}`} aria-label={label(d)} title={label(d)} style:--rot={`${TURN[d]}deg`} {...press(`dir-${d}`)}>
                  <span class="arrow"><Icon name="arrow" size={18} /></span>
                </button>
              {:else}
                <span class="centre" aria-hidden="true"></span>
              {/if}
            {/each}
          </div>
        {/if}
        {#if ptz.zoom || ptz.focus}
          <div class="lens">
            {#if ptz.zoom}
              <div class="row" role="group" aria-label="Zoom">
                <span class="what">Zoom</span>
                <button class="key" data-testid="ptz-zoom-out" aria-label="Zoom out" title="Zoom out" {...press('zoom-out')}>−</button>
                <button class="key" data-testid="ptz-zoom-in" aria-label="Zoom in" title="Zoom in" {...press('zoom-in')}>+</button>
              </div>
            {/if}
            {#if ptz.focus}
              <div class="row" role="group" aria-label="Focus">
                <span class="what">Focus</span>
                <button class="key" data-testid="ptz-focus-near" aria-label="Focus nearer" title="Focus nearer" {...press('focus-near')}>−</button>
                <button class="key" data-testid="ptz-focus-far" aria-label="Focus farther" title="Focus farther" {...press('focus-far')}>+</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
      {#if ptz.positions}
        <div class="positions">
          <div class="poshead">
            <span class="title">Positions</span>
            {#if positions}<span class="count">{positions.length} / {max}</span>{/if}
          </div>
          {#if positions === null}
            <p class="quiet" data-testid="ptz-loading">Loading positions…</p>
          {:else}
            {#if positions.length === 0}
              <p class="quiet" data-testid="ptz-empty" transition:reveal>No saved positions yet. Point the camera, then save its position.</p>
            {/if}
            <ul class="list" data-testid="ptz-positions">
              {#each positions as p, i (p.id)}
                <li class="row" class:missing={p.state === 'missing'} class:drop={dropOn === p.id && dragging !== p.id} data-testid="ptz-row" data-id={p.id}
                  animate:flip={{ duration: duration(150) }}
                  ondragover={(e) => { if (dragging) { e.preventDefault(); dropOn = p.id; } }}
                  ondragleave={() => { if (dropOn === p.id) dropOn = null; }}
                  ondrop={(e) => { e.preventDefault(); drop(p.id); }}>
                  {#if confirming === p.id}
                    <div class="confirm" data-testid="ptz-confirm" role="group" aria-label="Confirm">
                      {#if homeBlocked(p)}
                        <span class="msg">Home can't be deleted while other positions exist. Make another position Home first.</span>
                        <button class="small" data-testid="ptz-confirm-ok" onclick={() => (confirming = null)}>OK</button>
                      {:else}
                        <span class="msg">Delete “{p.name}”?</span>
                        <button class="small danger" data-testid="ptz-confirm-delete" disabled={busy} onclick={() => remove(p)}>Delete</button>
                        <button class="small" data-testid="ptz-confirm-cancel" onclick={() => (confirming = null)}>Cancel</button>
                      {/if}
                    </div>
                  {:else if renaming === p.id}
                    <div class="edit">
                      <input class="field" data-testid="ptz-rename-input" aria-label="Position name" maxlength="60" bind:value={renameValue}
                        oninput={() => (renameProblem = '')} onkeydown={(e) => renameKeys(e, p)} use:focusSelect />
                      <button class="small" data-testid="ptz-rename-save" disabled={busy} onclick={() => saveRename(p)}>Save</button>
                      <button class="small" data-testid="ptz-rename-cancel" onclick={() => (renaming = null)}>Cancel</button>
                      {#if renameProblem}<p class="problem" data-testid="ptz-rename-error" role="alert">{renameProblem}</p>{/if}
                    </div>
                  {:else}
                    <span class="grip" data-testid="ptz-grip" draggable="true" title="Drag to sort" aria-hidden="true"
                      ondragstart={(e) => { dragging = p.id; e.dataTransfer?.setData('text/plain', p.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; }}
                      ondragend={() => (dragging = dropOn = null)}><Icon name="grip" size={16} /></span>
                    {#if p.state === 'missing'}
                      <span class="name plain">{p.name}</span>
                      <button class="small" data-testid="ptz-resave" disabled={busy} onclick={() => resave(p)}>Save again</button>
                    {:else}
                      <button class="name go" data-testid="ptz-go" title={`Go to ${p.name}`} onclick={() => go(p)}>{p.name}</button>
                    {/if}
                    {#if p.home}
                      <span class="star home" data-testid="ptz-home-mark" role="img" aria-label="Home" title="Home"><Icon name="star" size={16} /></span>
                    {:else}
                      <button class="icon star" data-testid="ptz-make-home" aria-label="Make Home" title="Make Home" disabled={busy} onclick={() => makeHome(p)}><Icon name="star" size={16} /></button>
                    {/if}
                    <button class="icon" data-testid="ptz-rename" aria-label={`Rename ${p.name}`} title="Rename" onclick={() => startRename(p)}><Icon name="edit" size={15} /></button>
                    <button class="icon" data-testid="ptz-up" aria-label={`Move ${p.name} up`} title="Move up" disabled={i === 0 || busy} onclick={() => reorder(i, i - 1)}><span class="turn up"><Icon name="arrow" size={15} /></span></button>
                    <button class="icon" data-testid="ptz-down" aria-label={`Move ${p.name} down`} title="Move down" disabled={i === positions.length - 1 || busy} onclick={() => reorder(i, i + 1)}><span class="turn down"><Icon name="arrow" size={15} /></span></button>
                    <button class="icon" data-testid="ptz-delete" aria-label={`Delete ${p.name}`} title="Delete" onclick={() => { renaming = null; confirming = p.id; }}><Icon name="trash" size={15} /></button>
                    {#if p.state === 'missing'}<span class="lost">Not on the camera — save again</span>{/if}
                  {/if}
                </li>
              {/each}
            </ul>
            {#if saving}
              <div class="edit saveform" transition:reveal={{ duration: 120 }}>
                <input class="field" data-testid="ptz-save-input" aria-label="Name of the new position" maxlength="60" bind:value={saveValue}
                  oninput={() => (saveProblem = '')} onkeydown={saveKeys} use:focusSelect />
                <button class="small" data-testid="ptz-save-confirm" disabled={busy} onclick={submitSave}>Save</button>
                <button class="small" data-testid="ptz-save-cancel" onclick={() => (saving = false)}>Cancel</button>
                {#if saveProblem}<p class="problem" data-testid="ptz-save-error" role="alert">{saveProblem}</p>{/if}
              </div>
            {:else}
              <button class="savebtn" data-testid="ptz-save" disabled={full || busy} onclick={startSave}>Save position</button>
            {/if}
            {#if full}
              <p class="quiet" data-testid="ptz-max-note">{max} positions saved — the most a camera keeps. Delete one to save another.</p>
            {/if}
          {/if}
        </div>
      {/if}
      {#if error}
        <p class="error" data-testid="ptz-error" role="alert" transition:reveal={{ duration: 120 }}>{error}</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; }
  .head {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 0; border: 0; background: none;
    color: var(--text); font: inherit; cursor: pointer; text-align: left;
  }
  .title { font-size: 13px; font-weight: 600; color: var(--muted); }
  .head:hover .title { color: var(--text); }
  .chev { margin-left: auto; display: inline-flex; color: var(--muted); transform: rotate(180deg); transition: transform 160ms ease; }
  .chev.open { transform: rotate(270deg); }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
  .body { padding-top: 10px; }
  .controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .pad { display: grid; grid-template-columns: repeat(3, 40px); grid-auto-rows: 40px; gap: 6px; }
  .key {
    display: inline-flex; align-items: center; justify-content: center; min-width: 40px; height: 40px; padding: 0;
    border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
    font: inherit; font-size: 18px; line-height: 1; cursor: pointer;
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .key:hover { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .key:active { background: color-mix(in srgb, var(--accent) 26%, var(--surface-2)); border-color: var(--accent); }
  .key:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .arrow { display: inline-flex; transform: rotate(var(--rot)); }
  .centre { width: 40px; height: 40px; border-radius: 50%; border: 1px dashed var(--border); opacity: 0.6; }
  .lens { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .what { width: 44px; font-size: 13px; color: var(--muted); }
  .error { margin: 10px 0 0; font-size: 13px; color: var(--danger); }

  .positions { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); --ptz-row: 40px; }
  .poshead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .count { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .quiet { margin: 6px 0; font-size: 13px; color: var(--muted); }
  .list { list-style: none; margin: 0; padding: 0; max-height: calc(5 * var(--ptz-row)); overflow: auto; }
  .row {
    display: flex; align-items: center; gap: 2px; min-height: var(--ptz-row); box-sizing: border-box; padding: 0 2px;
    border-radius: 8px; border: 1px solid transparent; transition: background-color 120ms ease, border-color 120ms ease;
  }
  .row:hover { background: var(--surface-2); }
  .row.drop { border-color: var(--accent); }
  .grip { flex: none; display: inline-flex; color: var(--muted); cursor: grab; padding: 4px 2px; opacity: 0.7; }
  .grip:active { cursor: grabbing; }
  @media (pointer: coarse) { .grip { display: none; } .row .lost { padding-left: 8px; } }
  .name {
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: inherit; font-size: 14px; color: var(--text); text-align: left;
  }
  .go { padding: 6px 6px; border: 0; border-radius: 6px; background: none; cursor: pointer; }
  .go:hover { color: var(--accent); }
  .go:focus-visible, .icon:focus-visible, .small:focus-visible, .savebtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .plain { padding: 0 6px; color: var(--muted); }
  /* A missing row takes a second line for the note. */
  .row.missing { flex-wrap: wrap; }
  .lost { flex-basis: 100%; margin: -4px 0 0; padding: 0 0 6px 26px; font-size: 12px; color: var(--warning); }
  .icon {
    flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
    border: 0; border-radius: 7px; background: none; color: var(--muted); cursor: pointer;
  }
  .icon:hover:not(:disabled) { color: var(--text); background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .icon:disabled { opacity: 0.3; cursor: default; }
  .star { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; }
  .star.home { color: var(--accent); }
  .star.home :global(svg) { fill: currentColor; }
  button.star { opacity: 0.45; }
  button.star:hover:not(:disabled) { opacity: 1; }
  .turn { display: inline-flex; }
  .turn.up { transform: rotate(-90deg); }
  .turn.down { transform: rotate(90deg); }
  .confirm, .edit { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; width: 100%; padding: 4px 2px; }
  .msg { flex: 1 1 140px; min-width: 0; font-size: 13px; color: var(--text); }
  .field {
    flex: 1 1 120px; min-width: 0; height: 30px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface-2); color: var(--text); font: inherit; font-size: 14px;
  }
  .field:focus { outline: none; border-color: var(--accent); }
  .problem { width: 100%; margin: 0; font-size: 12px; color: var(--danger); }
  .small {
    flex: none; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text); font: inherit; font-size: 12px; cursor: pointer;
  }
  .small:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .small.danger { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); color: var(--danger); }
  .small:disabled { opacity: 0.45; cursor: default; }
  .saveform { margin-top: 8px; }
  .savebtn {
    margin-top: 8px; padding: 7px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text); font: inherit; font-size: 13px; cursor: pointer;
  }
  .savebtn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .savebtn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
