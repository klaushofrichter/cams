// Renders the SVG mark to the PNG sizes browsers and iOS ask for. Run with
// `npm run icons` after changing web/public/favicon.svg; outputs are committed.
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('web/public/favicon.svg');
for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-512.png', 512]]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(`web/public/${name}`, png);
  console.log(`wrote web/public/${name} (${size}px)`);
}
