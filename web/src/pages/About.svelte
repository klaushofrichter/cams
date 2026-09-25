<script lang="ts">
  import { me } from '../lib/stores';
</script>

<section class="page">
  <h1 data-testid="page-title">About</h1>
  <div class="card">
    <p><strong>cams</strong> by Skylar Technology LLC: a private viewer for our Reolink security cameras.</p>
    <p>Version <code data-testid="about-version">{$me?.version ?? '…'}</code></p>
    <p><a href="https://github.com/klaushofrichter/cams" target="_blank" rel="noopener noreferrer">Source on GitHub</a></p>
  </div>
</section>
