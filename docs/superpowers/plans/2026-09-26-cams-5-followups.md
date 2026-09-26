# Plan 5 follow-ups

- **Breaker opens on a fully offline camera too.** Any final `camera_offline` on a clip transfer counts toward the breaker, including a camera that is completely down. The banner wording no longer promises that live video works, but it still says "camera-side problem".
- **Mid-body drops never trip the breaker.** A camera that answers 200 and then drops the body counts as success. This fits today's failure (a reset before any response); revisit it if the real failure mode changes.
- **The Recordings banner is covered by e2e only** (the mock camera "Shed" refuses every download). The plan asked for a component test.
- **Remaining breaker cases.** These are correct by construction (one-slot gate, and `guard` runs inside the slot) but have no dedicated tests: the concurrent-probe race, and not counting aborted downloads or `camera_error`.
- **The real camera still refuses every download.** This is a camera-side problem, and cams now handles it gracefully. Clips will come through FTP intake on the planned camera gateway (`~/Development/reolink/camera-gateway-design.md`).
