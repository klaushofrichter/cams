# Changelog

Versions are generated at deploy time as `vYYYY.MM.DD.N` (America/Chicago) and
published as [GitHub releases](https://github.com/klaushofrichter/cams/releases).

<!-- Anything under Unreleased is prepended to the next release's notes by
     deploy-production.yml, then cleared. This file is not an archive. -->

## [Unreleased]

### Changed

- The public pages (the start page, the sign-in pages) can be zoomed on a phone, as accessibility guidelines ask; the signed-in app still holds still. The token field is a touch larger, so iPhones don't zoom in when it is tapped.
- Text on the public pages is easier to read: the light theme's accent text (section labels, "Read more", links) and the sign-in buttons are a deeper teal, the start page's gradient buttons and chat bubbles are a deeper teal-to-indigo in both themes, the outlined repository names are a little stronger, and the demo sash's stripes are lighter in the light theme. Every text now has WCAG AA contrast against what is really behind it.
- An unknown address shows a page in the site's style ("Page not found", with a way back) instead of a plain "Not found".

### Fixed
- Phone: leaving fullscreen with a double tap no longer presses what is under your finger afterwards. On a slow phone, the second tap could open the Timeline through the "Show in Timeline" link.
- The start page's scripts, stylesheets, screenshots and icons no longer count against the visitor's page limit, so browsing the public pages never ends in "too many requests" for the page's own files. They have their own, much larger limit.

