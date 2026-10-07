// @vitest-environment jsdom
//
// "Check with Vision" calls Vision through the proxy (a cost): account
// admins only (migration P4, M §9.5); "Save clip around this" stays for
// viewers (R4-9, the coordinator's decision).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import StillCheck from './StillCheck.svelte';
import { me } from '../lib/stores';

let component: Record<string, unknown> | undefined;
let target: HTMLDivElement | undefined;
afterEach(() => {
  if (component) unmount(component);
  target?.remove();
  component = target = undefined;
  me.set(null);
});
function render() {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(StillCheck, { target, props: { base: '/api/cameras/den', ts: 1_000, gap: false, check: null, analysed: false, usage: { kind: 'unknown' }, onresult: () => undefined, ondone: () => undefined, onaround: () => undefined } });
  flushSync();
}
const q = (id: string) => target!.querySelector(`[data-testid="${id}"]`);

describe('StillCheck', () => {
  it('an admin gets "Check with Vision" and "Save clip around this"', () => {
    me.set({ email: 'a', version: 'v', buildDate: null, role: 'admin' });
    render();
    expect(q('still-check-button')).not.toBeNull();
    expect(q('still-around-button')).not.toBeNull();
  });
  it('a viewer gets only "Save clip around this"', () => {
    me.set({ email: 'v', version: 'v', buildDate: null, role: 'viewer' });
    render();
    expect(q('still-check-button')).toBeNull();
    expect(q('still-around-button')).not.toBeNull();
  });
});
