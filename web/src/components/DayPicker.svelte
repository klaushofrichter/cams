<script lang="ts">
  import Icon from './Icon.svelte';
  let { date, days, today, onchange }: { date: string; days: string[]; today: string; onchange: (d: string) => void } = $props();
  const prevDay = $derived([...days].filter((d) => d < date).sort().at(-1) ?? null);
  const nextDay = $derived(days.filter((d) => d > date && d <= today).sort()[0] ?? null);
</script>

<div class="picker">
  <button data-testid="day-prev" disabled={!prevDay} onclick={() => prevDay && onchange(prevDay)} aria-label="Previous day with recordings">
    <Icon name="calendarPrev" size={16} />
  </button>
  <input
    type="date"
    data-testid="day-picker"
    value={date}
    max={today}
    onchange={(e) => {
      const input = e.currentTarget as HTMLInputElement;
      const v = input.value;
      if (v && v <= today) onchange(v);
      else input.value = date;
    }}
  />
  <button data-testid="day-next" disabled={!nextDay} onclick={() => nextDay && onchange(nextDay)} aria-label="Next day with recordings">
    <Icon name="calendarNext" size={16} />
  </button>
</div>

<style>
  .picker { display: inline-flex; align-items: center; gap: 6px; }
  button { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  input { font: inherit; font-size: 14px; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 9px; padding: 5px 10px; color-scheme: inherit; }
</style>
