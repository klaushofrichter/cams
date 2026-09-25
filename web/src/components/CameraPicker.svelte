<script lang="ts">
  import { cameras, selectedCameraId } from '../lib/stores';
</script>

<label class="picker">
  <span class="sr-only">Camera</span>
  <select data-testid="camera-picker" bind:value={$selectedCameraId} disabled={$cameras.length === 0}>
    {#if $cameras.length === 0}
      <option value={null}>No cameras</option>
    {:else}
      {#each $cameras as cam (cam.id)}
        <option value={cam.id}>{cam.name}</option>
      {/each}
    {/if}
  </select>
</label>

<style>
  select {
    appearance: none; font: inherit; font-size: 14px; color: var(--text);
    background: var(--surface-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239FB0CC' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center;
    border: 1px solid var(--border); border-radius: 10px; padding: 7px 30px 7px 12px; cursor: pointer;
  }
  select:disabled { opacity: 0.6; cursor: default; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
