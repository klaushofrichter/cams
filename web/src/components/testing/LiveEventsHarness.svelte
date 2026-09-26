<script lang="ts">
  // A minimal stand-in for Live.svelte's mini-timeline events effect (fix
  // round 1, item 7): keyed by `${id}|${date}` so a local-midnight rollover
  // (date changes, camera id doesn't) is treated as a fresh load -- clearing
  // yesterday's clips -- rather than a refresh, which would otherwise keep
  // drawing them on top of today's axis until the next poll replaced them.
  let {
    id,
    date,
    fetcher,
  }: {
    id: string;
    date: string;
    fetcher: (seq: number) => Promise<string[]>;
  } = $props();

  let todayEvents: string[] = $state([]);
  let lastEventsKey = '';
  let seq = 0;

  $effect(() => {
    const key = `${id}|${date}`;
    const isRefresh = key === lastEventsKey;
    lastEventsKey = key;
    const s = ++seq;
    if (!isRefresh) todayEvents = [];
    fetcher(s).then((events) => {
      if (s !== seq) return;
      todayEvents = events;
    });
  });

  export function snapshot(): { events: string[] } {
    return { events: todayEvents };
  }
</script>
