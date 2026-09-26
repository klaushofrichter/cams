<script lang="ts">
  import { cameras, me } from '../lib/stores';
  import { getJson } from '../lib/api';
  import { LICENCES } from '../lib/licences';
  import type { DeviceInfo } from '../lib/settings';

  let devices: Record<string, DeviceInfo | 'offline'> = $state({});
  $effect(() => {
    for (const c of $cameras) {
      if (devices[c.id]) continue;
      getJson<DeviceInfo>(`/api/cameras/${encodeURIComponent(c.id)}/device`)
        .then((d) => (devices = { ...devices, [c.id]: d }))
        .catch(() => (devices = { ...devices, [c.id]: 'offline' }));
    }
  });
  const built = $derived($me?.buildDate ? new Date($me.buildDate).toLocaleString() : 'not recorded (local build)');
  const version = $derived($me?.version ?? '…');
  const release = $derived(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(version) ? `https://github.com/klaushofrichter/cams/releases/tag/v${version}` : 'https://github.com/klaushofrichter/cams');
</script>

<section class="page">
  <h1 data-testid="page-title">About</h1>
  <div class="cards">
    <div class="card">
      <p><strong>cams</strong> by <a href="https://skylar.technology" target="_blank" rel="noopener noreferrer">Skylar Technology LLC</a>: a private viewer for our Reolink security cameras.</p>
      <dl>
        <dt>Version</dt><dd><a data-testid="about-version" href={release} target="_blank" rel="noopener noreferrer">{version}</a></dd>
        <dt>Built</dt><dd data-testid="about-build">{built}</dd>
        <dt>Source</dt><dd><a href="https://github.com/klaushofrichter/cams" target="_blank" rel="noopener noreferrer">github.com/klaushofrichter/cams</a></dd>
      </dl>
    </div>
    <div class="card">
      <h2>Supported cameras</h2>
      <ul data-testid="about-cameras">
        {#each $cameras as c (c.id)}
          {@const d = devices[c.id]}
          <li><strong>{c.name}</strong>: {#if d === 'offline'}offline{:else if d}{d.model}, firmware {d.firmware}{:else}…{/if}</li>
        {/each}
      </ul>
      <p class="muted">Tested with the Reolink RLC-1224A on firmware v3.2.0.6011. How its API behaves is documented in <a href="https://github.com/klaushofrichter/cams/blob/main/docs/reolink-api.md" target="_blank" rel="noopener noreferrer">docs/reolink-api.md</a>.</p>
    </div>
    <div class="card">
      <h2>Credits and licences</h2>
      <ul data-testid="about-licences">
        {#each LICENCES as l (l.name)}
          <li><a href={l.url} target="_blank" rel="noopener noreferrer">{l.name}</a>: {l.licence}, {l.use}</li>
        {/each}
      </ul>
      <p class="muted">Reolink is a trademark of its owner. cams is not affiliated with Reolink.</p>
    </div>
  </div>
</section>

<style>
  .cards { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); align-items: start; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
  h2 { margin: 0 0 10px; font-size: 16px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 12px 0 0; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
  .muted { color: var(--muted); font-size: 13px; }
  a { color: var(--accent); }
</style>
