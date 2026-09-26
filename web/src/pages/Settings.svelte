<script lang="ts">
  import SettingsCard from '../components/SettingsCard.svelte';
  import SaveState from '../components/SaveState.svelte';
  import Icon from '../components/Icon.svelte';
  import { cameras, selectedCameraId } from '../lib/stores';
  import { getJson } from '../lib/api';
  import {
    diffPatch, FIELD_LABELS, OSD_POSITIONS, postJson, putJson,
    type DetectionSettings, type DeviceInfo, type ImageSettings, type SaveResult,
  } from '../lib/settings';
  import { preferences, savePreferences, type Preferences } from '../lib/preferences';

  type State = 'idle' | 'saving' | 'saved' | 'partial' | 'error';
  const AI: { kind: 'person' | 'vehicle' | 'pet'; label: string }[] = [
    { kind: 'person', label: 'People' },
    { kind: 'vehicle', label: 'Vehicles' },
    { kind: 'pet', label: 'Pets' },
  ];

  // A checkbox's `indeterminate` state is a DOM property, not a reflected
  // HTML attribute, so it can't be set with `indeterminate={...}` in
  // markup. This action keeps it in sync with a reactive value instead.
  function indeterminate(node: HTMLInputElement, value: boolean) {
    node.indeterminate = value;
    return {
      update(next: boolean) {
        node.indeterminate = next;
      },
    };
  }

  // --- preferences ---
  let prefs: Preferences | null = $state(null);
  let prefsState: State = $state('idle');
  $effect(() => {
    if ($preferences && !prefs) prefs = structuredClone($preferences);
  });
  const prefsDirty = $derived(!!prefs && !!$preferences && Object.keys(diffPatch($preferences, prefs)).length > 0);
  async function savePrefs() {
    if (!prefs || !$preferences) return;
    prefsState = 'saving';
    prefsState = (await savePreferences(diffPatch($preferences, prefs))) ? 'saved' : 'error';
    if (prefsState === 'saved' && $preferences) prefs = structuredClone($preferences);
  }

  // --- camera cards ---
  let loadError = $state('');
  let detection: DetectionSettings | null = $state(null);
  let detectionEdit: DetectionSettings | null = $state(null);
  let detectionState: State = $state('idle');
  let detectionErrors: Record<string, string> = $state({});
  let image: ImageSettings | null = $state(null);
  let imageEdit: ImageSettings | null = $state(null);
  let imageState: State = $state('idle');
  let imageErrors: Record<string, string> = $state({});
  let device: DeviceInfo | null = $state(null);
  let seq = 0;

  $effect(() => {
    const id = $selectedCameraId;
    const mine = ++seq;
    detection = detectionEdit = image = imageEdit = device = null;
    loadError = '';
    if (!id) return;
    getJson<{ detection: DetectionSettings; image: ImageSettings }>(`/api/cameras/${encodeURIComponent(id)}/settings`)
      .then((s) => {
        if (mine !== seq) return;
        detection = s.detection;
        detectionEdit = structuredClone(s.detection);
        image = s.image;
        imageEdit = structuredClone(s.image);
      })
      .catch(() => {
        if (mine === seq) loadError = 'The camera settings could not be loaded. The camera may be offline.';
      });
    getJson<DeviceInfo>(`/api/cameras/${encodeURIComponent(id)}/device`)
      .then((d) => {
        if (mine === seq) device = d;
      })
      .catch(() => {});
  });

  const detectionDirty = $derived(!!detection && !!detectionEdit && Object.keys(diffPatch(detection, detectionEdit)).length > 0);
  const imageDirty = $derived(!!image && !!imageEdit && Object.keys(diffPatch(image, imageEdit)).length > 0);

  function errorsOf(fields: Record<string, { ok: boolean; error?: string }>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [f, r] of Object.entries(fields)) if (!r.ok) out[f] = r.error === 'not_applied' ? 'Not applied' : 'Rejected by the camera';
    return out;
  }

  // A failed save (anything but 200/207) may have partially applied
  // commands on the camera, so the card is re-fetched to show the true
  // state rather than trusting the optimistic `edited` copy.
  async function reload(section: 'detection' | 'image') {
    if (!$selectedCameraId) return;
    try {
      const s = await getJson<{ detection: DetectionSettings; image: ImageSettings }>(
        `/api/cameras/${encodeURIComponent($selectedCameraId)}/settings`,
      );
      if (section === 'detection') {
        detection = s.detection;
        detectionEdit = structuredClone(s.detection);
      } else {
        image = s.image;
        imageEdit = structuredClone(s.image);
      }
    } catch {
      // Keep whatever was last known; the error state above already shows.
    }
  }

  async function save<T extends object>(section: 'detection' | 'image', original: T, edited: T) {
    const set = section === 'detection' ? (s: State) => (detectionState = s) : (s: State) => (imageState = s);
    set('saving');
    try {
      const res = await putJson<SaveResult<T>>(`/api/cameras/${encodeURIComponent($selectedCameraId!)}/settings/${section}`, diffPatch(original, edited));
      if (res.status !== 200 && res.status !== 207) {
        set('error');
        await reload(section);
        return;
      }
      const errs = errorsOf(res.body.fields);
      if (section === 'detection') {
        detection = res.body.settings as unknown as DetectionSettings;
        detectionEdit = structuredClone(detection);
        detectionErrors = errs;
      } else {
        image = res.body.settings as unknown as ImageSettings;
        imageEdit = structuredClone(image);
        imageErrors = errs;
      }
      set(res.status === 200 ? 'saved' : 'partial');
    } catch {
      set('error');
      await reload(section);
    }
  }

  // --- reboot (review focus 4: two explicit clicks) ---
  let confirmReboot = $state(false);
  let rebootState: 'idle' | 'rebooting' | 'done' | 'partial' | 'error' = $state('idle');
  async function reboot() {
    rebootState = 'rebooting';
    const res = await postJson<{ ok?: boolean; confirmed?: boolean }>(`/api/cameras/${encodeURIComponent($selectedCameraId!)}/reboot`, { confirm: 'reboot' }).catch(() => null);
    rebootState = res?.status === 200 ? 'done' : res?.status === 202 ? 'partial' : 'error';
    confirmReboot = false;
  }

  const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
  const cameraName = $derived($cameras.find((c) => c.id === $selectedCameraId)?.name ?? '');
</script>

<section class="page">
  <h1 data-testid="page-title">Settings</h1>

  <div class="grid">
    <SettingsCard id="prefs" title="App preferences" description="How cams opens for you. Stored with your account.">
      {#if prefs}
        <label>Default camera
          <select data-testid="pref-camera" bind:value={prefs.defaultCamera}>
            <option value={null}>First camera</option>
            {#each $cameras as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
          </select>
        </label>
        <label>Live quality
          <select data-testid="pref-quality" bind:value={prefs.liveQuality}>
            <option value="sub">SD (plays everywhere)</option>
            <option value="main">HD (needs HEVC support)</option>
          </select>
        </label>
        <label>Event filter
          <select data-testid="pref-filter" bind:value={prefs.eventFilter}>
            <option value="all">All</option><option value="person">Person</option><option value="vehicle">Vehicle</option><option value="pet">Pet</option><option value="motion">Motion</option>
          </select>
        </label>
        <label>Timeline zoom
          <select data-testid="pref-zoom" bind:value={prefs.timelineZoom}>
            <option value={24}>24 hours</option><option value={6}>6 hours</option><option value={1}>1 hour</option>
          </select>
        </label>
        <label>Keep live video running after leaving Live
          <select data-testid="pref-keepalive" bind:value={prefs.liveKeepAlive}>
            <option value={0}>Off (stop at once)</option><option value={30}>30 seconds</option><option value={60}>1 minute</option>
            <option value={120}>2 minutes</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option>
          </select>
          <small class="muted">Coming back within this time shows the live picture at once. Longer uses more bandwidth.</small>
        </label>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
      {#snippet footer()}
        <SaveState state={prefsState} />
        <button class="primary" data-testid="save-prefs" disabled={!prefsDirty || prefsState === 'saving'} onclick={savePrefs}>Save</button>
      {/snippet}
    </SettingsCard>

    <SettingsCard id="detection" title="Detection and recording" description={cameraName ? `What ${cameraName} records.` : ''}>
      {#if detectionEdit}
        <label class="row"><input type="checkbox" data-testid="recording-toggle" bind:checked={detectionEdit.recording} /> Recording</label>
        <label class="row">
          <input type="checkbox" data-testid="motion-recording-toggle" checked={detectionEdit.motionRecording === 'on'}
            use:indeterminate={detectionEdit.motionRecording === 'custom'}
            onchange={(e) => (detectionEdit!.motionRecording = (e.currentTarget as HTMLInputElement).checked ? 'on' : 'off')} />
          Record on motion {#if detectionEdit.motionRecording === 'custom'}<small class="muted">(custom schedule)</small>{/if}
        </label>
        {#if detectionErrors.motionRecording}<span class="err" data-testid="field-error-motionRecording">{detectionErrors.motionRecording}</span>{/if}
        <label>Motion sensitivity <output>{detectionEdit.motionSensitivity}</output>
          <input type="range" min="1" max="50" data-testid="motion-sensitivity" bind:value={detectionEdit.motionSensitivity} />
        </label>
        {#if detectionErrors.motionSensitivity}<span class="err" data-testid="field-error-motionSensitivity">{detectionErrors.motionSensitivity}</span>{/if}
        {#each AI as a (a.kind)}
          <div class="ai">
            <label class="row">
              <input type="checkbox" data-testid={`ai-${a.kind}-record`} checked={detectionEdit.ai[a.kind].record === 'on'}
                use:indeterminate={detectionEdit.ai[a.kind].record === 'custom'}
                onchange={(e) => (detectionEdit!.ai[a.kind].record = (e.currentTarget as HTMLInputElement).checked ? 'on' : 'off')} />
              Record {a.label.toLowerCase()} {#if detectionEdit.ai[a.kind].record === 'custom'}<small class="muted">(custom schedule)</small>{/if}
            </label>
            <label>{a.label} sensitivity <output>{detectionEdit.ai[a.kind].sensitivity}</output>
              <input type="range" min="0" max="100" data-testid={`ai-${a.kind}-sensitivity`} bind:value={detectionEdit.ai[a.kind].sensitivity} />
            </label>
            {#each [`ai.${a.kind}.record`, `ai.${a.kind}.sensitivity`] as f (f)}
              {#if detectionErrors[f]}<span class="err" data-testid={`field-error-${f}`}>{FIELD_LABELS[f]}: {detectionErrors[f]}</span>{/if}
            {/each}
          </div>
        {/each}
        {#if detectionErrors.recording}<span class="err" data-testid="field-error-recording">{detectionErrors.recording}</span>{/if}
      {:else if loadError}
        <p class="err" role="alert">{loadError}</p>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
      {#snippet footer()}
        <SaveState state={detectionState} />
        <button class="primary" data-testid="save-detection" disabled={!detectionDirty || detectionState === 'saving'} onclick={() => save('detection', detection!, detectionEdit!)}>Save</button>
      {/snippet}
    </SettingsCard>

    <SettingsCard id="image" title="Image and lights">
      {#if imageEdit}
        <label>Day/night
          <select data-testid="daynight-select" bind:value={imageEdit.dayNight}>
            <option value="auto">Automatic</option><option value="color">Always colour</option><option value="blackwhite">Always black and white</option>
          </select>
        </label>
        {#if imageErrors.dayNight}<span class="err" data-testid="field-error-dayNight">{imageErrors.dayNight}</span>{/if}
        <label>Infrared lights
          <select data-testid="ir-select" bind:value={imageEdit.irLights}>
            <option value="auto">Automatic</option><option value="off">Off</option>
          </select>
        </label>
        {#if imageErrors.irLights}<span class="err" data-testid="field-error-irLights">{imageErrors.irLights}</span>{/if}
        <label>Spotlight
          <select data-testid="spotlight-mode" bind:value={imageEdit.spotlight.mode}>
            <option value="off">Off</option><option value="auto">On motion at night</option><option value="night">On all night</option><option value="schedule">On a schedule</option>
          </select>
        </label>
        <label>Spotlight brightness <output>{imageEdit.spotlight.brightness}</output>
          <input type="range" min="0" max="100" data-testid="spotlight-brightness" bind:value={imageEdit.spotlight.brightness} />
        </label>
        {#if imageErrors.spotlight}<span class="err" data-testid="field-error-spotlight">{imageErrors.spotlight}</span>{/if}
        <fieldset>
          <legend>On-screen text</legend>
          <label class="row"><input type="checkbox" data-testid="osd-name-toggle" bind:checked={imageEdit.osd.showName} /> Show camera name</label>
          <label>Name <input data-testid="osd-name" maxlength="31" bind:value={imageEdit.osd.name} /></label>
          <label>Name position
            <select data-testid="osd-name-pos" bind:value={imageEdit.osd.namePosition}>{#each OSD_POSITIONS as p (p)}<option value={p}>{p}</option>{/each}</select>
          </label>
          <label class="row"><input type="checkbox" data-testid="osd-time-toggle" bind:checked={imageEdit.osd.showTime} /> Show date and time</label>
          <label>Time position
            <select data-testid="osd-time-pos" bind:value={imageEdit.osd.timePosition}>{#each OSD_POSITIONS as p (p)}<option value={p}>{p}</option>{/each}</select>
          </label>
          {#if imageErrors.osd}<span class="err" data-testid="field-error-osd">{imageErrors.osd}</span>{/if}
        </fieldset>
      {:else if loadError}
        <p class="err" role="alert">{loadError}</p>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
      {#snippet footer()}
        <SaveState state={imageState} />
        <button class="primary" data-testid="save-image" disabled={!imageDirty || imageState === 'saving'} onclick={() => save('image', image!, imageEdit!)}>Save</button>
      {/snippet}
    </SettingsCard>

    <SettingsCard id="device" title="Device and maintenance">
      {#if device}
        <dl>
          <dt>Model</dt><dd data-testid="device-model">{device.model}</dd>
          <dt>Firmware</dt><dd data-testid="device-firmware">{device.firmware}</dd>
          <dt>Storage</dt>
          <dd data-testid="device-storage">
            {#if device.storage}{gb(device.storage.usedMb)} of {gb(device.storage.totalMb)} used{#if !device.storage.mounted} (not mounted){/if}{:else}No SD card{/if}
          </dd>
          <dt>Certificate</dt>
          <dd data-testid="device-cert">
            {#if device.certificate}
              {device.certificate.subject}, {device.certificate.issuer}, expires {new Date(device.certificate.validTo).toLocaleDateString()} ({device.certificate.daysLeft} days)
            {:else}
              Not available
            {/if}
          </dd>
        </dl>
        <p class="webui">
          <a data-testid="device-webui-link" href={device.webUiUrl} target="_blank" rel="noopener noreferrer">
            Open the camera's own web page <Icon name="external" size={14} />
          </a>
          <small class="muted">Works on the home network only. The camera's page isn't reachable from the internet.</small>
        </p>
      {:else if loadError}
        <p class="err" role="alert">{loadError}</p>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
      {#snippet footer()}
        {#if rebootState === 'done'}<span class="muted" role="status">Rebooting. The camera is back in about a minute.</span>{/if}
        {#if rebootState === 'partial'}<span class="muted" role="status">Reboot sent. The camera didn't confirm; it should be back in about a minute.</span>{/if}
        {#if rebootState === 'error'}<span class="err" role="alert">The reboot request failed.</span>{/if}
        {#if confirmReboot}
          <span>Reboot {cameraName}? Recording stops for about a minute.</span>
          <button data-testid="reboot-cancel" onclick={() => (confirmReboot = false)}>Cancel</button>
          <button class="danger" data-testid="reboot-confirm" disabled={rebootState === 'rebooting'} onclick={reboot}>Reboot now</button>
        {:else}
          <button data-testid="reboot-button" disabled={!device} onclick={() => (confirmReboot = true)}><Icon name="power" size={14} /> Reboot camera…</button>
        {/if}
      {/snippet}
    </SettingsCard>
  </div>
</section>

<style>
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); align-items: start; }
  label { display: grid; gap: 6px; font-size: 14px; }
  label.row { display: flex; align-items: center; gap: 8px; }
  select, input:not([type='checkbox']):not([type='range']) { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 9px; padding: 6px 10px; }
  input[type='range'] { accent-color: var(--accent); }
  output { color: var(--muted); font-family: var(--mono); font-size: 12px; margin-left: 6px; }
  fieldset { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; display: grid; gap: 10px; }
  legend { padding: 0 6px; color: var(--muted); font-size: 13px; }
  .ai { display: grid; gap: 8px; padding-top: 6px; border-top: 1px dashed var(--border); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .webui { display: grid; gap: 4px; margin: 0; }
  .webui a { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); }
  .muted { color: var(--muted); }
  .err { color: var(--danger); font-size: 13px; }
  button { font: inherit; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  button.danger { background: var(--danger); color: #fff; border-color: transparent; }
</style>
