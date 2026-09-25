<!-- Brand artwork with fixed brand colours (matching the favicon); intentionally exempt from the theme-token rule. -->
<!-- Drawn illustration of a turret camera like the RLC-1224A. Our own artwork,
     not a manufacturer product photo. -->
<svg class="cam" viewBox="0 0 210 170" role="img" aria-label="Illustration of the Reolink RLC-1224A turret camera">
  <defs>
    <linearGradient id="cam-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#F4F6FA" />
      <stop offset="1" stop-color="#C9D1DE" />
    </linearGradient>
    <radialGradient id="cam-glass" cx=".4" cy=".35">
      <stop offset="0" stop-color="#3B4B6B" />
      <stop offset=".6" stop-color="#0B1220" />
    </radialGradient>
    <radialGradient id="cam-glow" cx=".5" cy=".5">
      <stop offset="0" stop-color="rgba(34,211,238,.45)" />
      <stop offset="1" stop-color="rgba(34,211,238,0)" />
    </radialGradient>
  </defs>
  <circle class="glow" cx="105" cy="95" r="80" fill="url(#cam-glow)" />
  <ellipse cx="105" cy="140" rx="70" ry="12" fill="#AEB8C8" />
  <rect x="45" y="118" width="120" height="22" rx="10" fill="url(#cam-body)" />
  <circle cx="105" cy="82" r="48" fill="url(#cam-body)" />
  <rect x="57" y="92" width="96" height="28" fill="url(#cam-body)" />
  <circle cx="105" cy="84" r="26" fill="url(#cam-glass)" />
  <circle cx="105" cy="84" r="12" fill="#0B1220" stroke="#22D3EE" stroke-width="2" />
  <circle cx="98" cy="77" r="4" fill="rgba(255,255,255,.7)" />
  <circle cx="80" cy="66" r="3" fill="#1F2937" />
  <circle cx="130" cy="66" r="3" fill="#1F2937" />
</svg>

<style>
  .cam { width: min(320px, 80vw); height: auto; filter: drop-shadow(var(--shadow)); }
  .glow { animation: pulse 4s ease-in-out infinite; transform-origin: 105px 95px; }
  @keyframes pulse { 0%, 100% { opacity: 0.7; transform: scale(1); } 50% { opacity: 1; transform: scale(1.06); } }
</style>
