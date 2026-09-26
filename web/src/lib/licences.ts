// Third-party software shipped in the app or its image. Licences checked
// against each package's package.json when this list was written.
export const LICENCES = [
  { name: 'Svelte', url: 'https://svelte.dev', licence: 'MIT', use: 'web interface' },
  { name: 'mpegts.js', url: 'https://github.com/xqq/mpegts.js', licence: 'Apache-2.0', use: 'live video playback' },
  { name: 'Express', url: 'https://expressjs.com', licence: 'MIT', use: 'web server' },
  { name: 'pino', url: 'https://getpino.io', licence: 'MIT', use: 'logging' },
  { name: 'google-auth-library', url: 'https://github.com/googleapis/google-auth-library-nodejs', licence: 'Apache-2.0', use: 'Google sign-in' },
  { name: 'jsonwebtoken', url: 'https://github.com/auth0/node-jsonwebtoken', licence: 'MIT', use: 'sessions' },
  { name: 'express-rate-limit', url: 'https://github.com/express-rate-limit/express-rate-limit', licence: 'MIT', use: 'rate limiting' },
  { name: 'FFmpeg', url: 'https://ffmpeg.org', licence: 'LGPL-2.1+ / GPL-2.0+ (Alpine build)', use: 'clip thumbnails (separate program)' },
  { name: 'Node.js', url: 'https://nodejs.org', licence: 'MIT', use: 'runtime' },
  { name: 'reolink_aio', url: 'https://github.com/starkillerOG/reolink_aio', licence: 'MIT', use: 'reference for the camera API (not shipped)' },
] as const;
