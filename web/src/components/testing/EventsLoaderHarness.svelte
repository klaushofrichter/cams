<script lang="ts">
  // A minimal stand-in for Recordings.svelte's events effect (fix round 1,
  // item 1): the same key/isRefresh/seq pattern, driven by $state props so a
  // test can race a refresh against the first load without pulling in the
  // whole page (stores, the router, the API layer, preferences...).
  let {
    loadKey,
    refreshTick,
    fetcher,
  }: {
    loadKey: string;
    refreshTick: number;
    fetcher: (seq: number) => Promise<void>;
  } = $props();

  let loading = $state(true);
  let failed = $state(false);
  let lastKey = '';
  let seq = 0;

  $effect(() => {
    const key = loadKey;
    void refreshTick;
    const isRefresh = key === lastKey;
    lastKey = key;
    const s = ++seq;
    if (!isRefresh) {
      loading = true;
      failed = false;
    }
    fetcher(s)
      .then(() => {
        if (s !== seq) return;
        loading = false;
        failed = false;
      })
      .catch(() => {
        if (s !== seq) return;
        if (!isRefresh) failed = true;
        loading = false;
      });
  });

  export function snapshot(): { loading: boolean; failed: boolean } {
    return { loading, failed };
  }
</script>
