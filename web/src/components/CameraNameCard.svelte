<script lang="ts">
  import { untrack } from 'svelte';
  import SettingsCard from './SettingsCard.svelte';
  import SaveState from './SaveState.svelte';
  import { cameraById, me } from '../lib/stores';
  import { showsAdminControls } from '../lib/session';
  import { CAMERA_NAME_MAX, cameraNameProblem, renameCamera } from '../lib/cameraName';

  // Settings → camera → Name (design camera-name-design.md). The camera
  // stores the name; every signed-in user may change it. Checked with the
  // camera's rules as you type; the answer is the name read back from it.
  let { cameraId }: { cameraId: string } = $props();

  const current = $derived($cameraById(cameraId)?.name ?? '');
  // Renaming is for account admins (migration P4); a viewer sees the name.
  const admin = $derived(showsAdminControls($me));
  let draft = $state('');
  let base = $state(''); // the name the draft started from
  let shownFor = '';
  let saveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  let serverError = $state<string | null>(null);

  // Another camera: start over. A rename made elsewhere (another tab, the
  // Reolink app, the camera's page): follow it, unless the field was edited.
  $effect(() => {
    const id = cameraId;
    const name = current;
    untrack(() => {
      if (id !== shownFor) {
        shownFor = id;
        draft = base = name;
        saveState = 'idle';
        serverError = null;
      } else if (draft === base) draft = base = name;
      else base = name;
    });
  });

  const dirty = $derived(draft !== current);
  const problem = $derived(dirty ? cameraNameProblem(draft) : null);
  const shownError = $derived(problem ?? serverError);

  function edited() {
    serverError = null;
    if (saveState !== 'saving') saveState = 'idle';
  }

  async function save() {
    const id = cameraId;
    const name = draft;
    saveState = 'saving';
    serverError = null;
    const r = await renameCamera(id, name);
    if (id !== cameraId) return; // switched camera meanwhile
    if (r.ok && r.name === name) {
      draft = base = r.name;
      saveState = 'saved';
    } else if (r.ok) {
      // The write was answered, but the camera reads back another name.
      draft = base = r.name;
      serverError = `The camera kept the name "${r.name}".`;
      saveState = 'error';
    } else {
      serverError = r.message;
      saveState = 'error';
    }
  }
</script>

<SettingsCard id="name" title="Camera name" description="Stored on the camera: the on-screen text, the Reolink app and cam-proxy show it too.">
  {#if !admin}
    <p data-testid="camera-name-readonly">{current}</p>
  {:else}
  <label>Name
    <input data-testid="camera-name-input" aria-invalid={!!shownError} aria-describedby="camera-name-help" autocomplete="off" spellcheck="false" bind:value={draft} oninput={edited} />
    <small id="camera-name-help" class="muted">
      <span data-testid="camera-name-count" class:err={draft.length > CAMERA_NAME_MAX}>{draft.length}/{CAMERA_NAME_MAX}</span>
      · letters A–Z, digits, space and - ( ) + = [ ] {'{'} {'}'}
    </small>
  </label>
  {#if shownError}<span class="err" role="alert" data-testid="camera-name-error">{shownError}</span>{/if}
  {/if}
  {#snippet footer()}
    {#if admin}
      <SaveState state={saveState} message={saveState === 'error' ? 'Not saved' : ''} />
      <button class="primary" data-testid="save-camera-name" disabled={!dirty || !!problem || saveState === 'saving'} onclick={save}>Save</button>
    {:else}<span class="muted">Account admins rename cameras.</span>{/if}
  {/snippet}
</SettingsCard>

<style>
  label { display: grid; gap: 6px; font-size: 14px; }
  input { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 9px; padding: 6px 10px; }
  input[aria-invalid='true'] { border-color: var(--danger); }
  .muted { color: var(--muted); }
  .err { color: var(--danger); font-size: 13px; }
  small .err { font-size: inherit; }
  button { font: inherit; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
</style>
