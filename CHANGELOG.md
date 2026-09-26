# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

- **Settings page:**
  - app preferences stored with your account: default camera, live quality, event filter, timeline zoom, live keep-alive;
  - detection and recording: recording, motion and AI types, sensitivities;
  - image and lights: day/night, infrared, spotlight, on-screen text;
  - device and maintenance: model, firmware, storage, certificate, reboot with confirmation.

  Every camera save is re-read and reported per field.
- **About page:** version, build date, cameras, credits and licences.
- **Camera web UI link** in the top bar and Settings. It works on the home network only.
- **Top-bar clock** with seconds and time zone.
- **Timeline labels** in real local time, and a legend and "now" marker under Live.
- **Today's recordings** and the Live mini timeline refresh on their own. Long days are grouped by hour.
- **Live keep-alive:** the live stream keeps running for the chosen time while off-screen (another page or a hidden tab), so coming back is instant.
- **Streaming indicator:** a green or red frame on the favicon and logo, with the status in the tab title and the logo tooltip.

