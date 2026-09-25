<script lang="ts">
  let { size = 28 }: { size?: number } = $props();
  const id = `lens-${Math.random().toString(36).slice(2, 8)}`;
</script>

<svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22D3EE" />
      <stop offset="1" stop-color="#6366F1" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#{id})" />
  <circle cx="32" cy="32" r="17" fill="#0B1220" />
  <circle cx="32" cy="32" r="9" fill="none" stroke="#22D3EE" stroke-width="3" />
  <circle cx="36" cy="28" r="2.6" fill="#E6EDF7" />
</svg>
