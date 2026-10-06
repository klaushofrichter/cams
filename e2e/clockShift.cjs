// Moves `Date` by a fixed offset, so the e2e stack runs at another time of
// day (scripts/e2e-time-of-day.ts, issue #213). Loaded into every Node
// process of a run with NODE_OPTIONS="--require <this file>" and
// E2E_CLOCK_SHIFT_MS: Playwright's runner and workers, the cams servers, the
// cam-sim cameras and the fake cam-proxy all see the same shifted "now". The
// browser gets the same function as an init script (e2e/clock.ts).
// Only the wall clock moves: timers, performance.now() and process.hrtime()
// keep running in real time, as they would at that hour.
//
// Plain JavaScript and self-contained: Playwright serialises shiftDate() into
// the page, and Node loads this file before any TypeScript loader.
function shiftDate(offsetMs) {
  if (!offsetMs) return;
  const RealDate = Date;
  const now = () => RealDate.now() + offsetMs;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [now()], newTarget === globalThis.Date ? target : newTarget);
    },
    apply() {
      return new RealDate(now()).toString(); // Date() without new
    },
    get(target, prop, receiver) {
      if (prop === 'now') return now;
      return Reflect.get(target, prop, receiver);
    },
  });
}

if (typeof module !== 'undefined') module.exports = { shiftDate };
if (typeof process !== 'undefined' && process.env && process.env.E2E_CLOCK_SHIFT_MS) shiftDate(Number(process.env.E2E_CLOCK_SHIFT_MS));
