// The landing page's copy: highlights (a summary, each pointing to its
// section), numbers, the feature sections and the repositories. Public and
// pre-login, so no addresses, host names, ids or tokens in the text
// (landingContent.test.ts). Claim only what has shipped in cams, cam-proxy,
// cam-sim, cams-admin and cam-proxy-pi-display. Terms: the proxy (cam-proxy,
// never "gateway"), the app (cams), cams-admin (the admin console), account,
// fleet, camera move, archive, site CA, the proxy's admin UI, the camera
// abstraction (cam-sim).
import type { IconName } from './icons';

export const ADMIN_CONSOLE_URL = 'https://cams-admin.skylar.technology';

export interface Highlight {
  section: string;
  icon: IconName;
  kicker: string;
  title: string;
  text: string;
}

export interface Feature {
  icon: IconName;
  title: string;
  text: string;
}

// A screenshot of the app under /landing/ (web/public/landing/). A missing
// file hides its frame (LandingShot), so the page works without them.
export interface Shot {
  src: string;
  alt: string;
  width: number;
  height: number;
  // The frame drawn around it: a browser window (default), a phone, or the
  // Pi's e-paper display (a 264×176 black-and-white panel, scaled up crisply).
  frame?: 'browser' | 'phone' | 'epaper';
}

export interface Section {
  id: string;
  kicker: string;
  title: string;
  lead: string;
  features: Feature[];
  shots?: Shot[];
}

export interface Repo {
  name: string;
  url: string;
  text: string;
}

const shot = (name: string, alt: string, width = 1200, height = 750): Shot => ({ src: `/landing/${name}.webp`, alt, width, height });

// The product shot over the highlights: the desktop Video page, with the phone in front.
export const SHOWCASE = {
  desktop: shot('live', 'The Video page in a desktop browser: the live picture with its LIVE badge, the day strip below and the day’s events on the right'),
  phone: shot('phone-live', 'The Video page on a phone: the live picture, the playback controls and the day strip', 540, 1169),
};

// The Pi's e-paper display (264×176, black and white, drawn 3× by
// cam-proxy-pi-display's fake panel): its four pages, in the order its keys
// select them. The Hardware section cycles them like the display.
const epaper = (name: string, alt: string): Shot => ({ ...shot(`epaper-${name.toLowerCase()}`, `The e-paper display’s ${name} page: ${alt}`, 792, 528), frame: 'epaper' });
export const EPAPER_PAGES: (Shot & { name: string })[] = [
  { name: 'Overview', ...epaper('Overview', 'camera online, live stream up, events subscribed, storage, disk and archive, and “All OK” at the bottom') },
  { name: 'Camera', ...epaper('Camera', 'the camera online, its model and firmware, the stream, events, FTP and the last clip') },
  { name: 'Proxy', ...epaper('Proxy', 'the proxy’s version, up since, clips stored, storage, the recordings cache, viewers and the last retention run') },
  { name: 'Pi', ...epaper('Pi', 'the Raspberry Pi’s model, disk, free space, CPU temperature, memory, uptime, load and under-voltage') },
];

// One card per section: a short summary that links down to the details.
export const HIGHLIGHTS: Highlight[] = [
  { section: 'watch', icon: 'live', kicker: 'Watch', title: 'Live and recorded, one player', text: 'Slide from now into the past without switching screens.' },
  { section: 'find', icon: 'person', kicker: 'Find', title: 'The right moment, fast', text: 'AI labels, a second AI opinion and a still for every second.' },
  { section: 'keep', icon: 'archive', kicker: 'Keep', title: 'Clips worth keeping', text: 'Download, compose and archive what matters.' },
  { section: 'cameras', icon: 'camera', kicker: 'Cameras', title: 'Works with Reolink', text: 'Every camera feature measured on the RLC-1224A.' },
  { section: 'proxy', icon: 'server', kicker: 'Proxy', title: 'Smart where the cameras are', text: 'A local proxy keeps the footage on your own network.' },
  { section: 'hardware', icon: 'layers', kicker: 'Hardware', title: 'Small to start, ready to grow', text: 'From one Raspberry Pi to a proxy with many cameras.' },
  { section: 'fleet', icon: 'users', kicker: 'Fleet', title: 'Every site in one console', text: 'Accounts, proxies and cameras, managed centrally.' },
  { section: 'open', icon: 'code', kicker: 'Open', title: 'Open, and built with AI', text: 'Public code, documented APIs, MCP for your assistant.' },
];

export const NUMBERS = [
  { value: 1, suffix: '', label: 'still per second, kept by the proxy' },
  { value: 4, suffix: 'K', label: 'original recordings, straight from the camera' },
  { value: 10, suffix: '+', label: 'cameras on one proxy (estimated)' },
  { value: 5, suffix: '', label: 'public repositories on GitHub' },
];

export const SECTIONS: Section[] = [
  {
    id: 'watch',
    kicker: 'Watch',
    title: 'See it as it happens',
    lead: 'Open the app and the picture is there. Drag back in time and it plays on.',
    features: [
      {
        icon: 'live',
        title: 'Live video',
        text: 'Watch in SD or 4K, turn on the sound or the camera’s spotlight, and take a snapshot. If the stream stalls, the proxy’s newest still fills in every second.',
      },
      {
        icon: 'history',
        title: 'The strip',
        text: 'Its right end is live. Drag left and playback runs on in real time through clips and stills, across days. Zoom from 24 hours down to 30 minutes.',
      },
      {
        icon: 'phone',
        title: 'Fullscreen, on any screen',
        text: 'Step 1 or 10 seconds, jump between events, or go back to live: by keyboard on a desktop, by swipe and tap on a phone. Added to the home screen it opens like an app, in light or dark.',
      },
    ],
    shots: [shot('playback', 'Playing a recorded person event: the REC badge with its time, the playback controls, and the event highlighted in the list')],
  },
  {
    id: 'find',
    kicker: 'Find',
    title: 'Find the moment in seconds',
    lead: 'Every recording is sorted, labelled and one click from playing.',
    features: [
      {
        icon: 'events',
        title: 'Events by hour',
        text: 'Each event shows a thumbnail from the moment of detection and counts the people, vehicles and pets the camera saw. Filter by kind.',
      },
      {
        icon: 'sparkle',
        title: 'Secondary AI analytics',
        text: 'Optionally, the proxy sends the still of a person, vehicle or pet event to Google Vision for a second opinion: its confidence and boxes show next to the camera’s label, and any still can be checked by hand. The budget is built in: a monthly limit, a daily cap and a number of checks per camera and day, with the usage on screen; at a limit the calls stop until the day or month turns. Google Vision today, through a provider interface made for other AI models.',
      },
      {
        icon: 'timeline',
        title: 'The Timeline',
        text: 'One tile per minute, sixty stills per minute. Step second by second, then open that moment in the player.',
      },
      {
        icon: 'motion',
        title: 'News at once',
        text: 'A new event appears in the list as it is recorded. No reloading.',
      },
    ],
    shots: [
      shot('timeline', 'The Timeline page: one tile per minute, an open minute with its sixty stills, and the large still of the chosen second'),
      shot('events', 'The day’s events grouped by hour, each with a thumbnail, its length and labels such as Person, Vehicle and Motion', 392, 750),
    ],
  },
  {
    id: 'keep',
    kicker: 'Keep',
    title: 'Save it, share it, keep it',
    lead: 'Take the footage with you exactly the way you need it.',
    features: [
      {
        icon: 'download',
        title: 'Downloads in SD or 4K',
        text: 'Save any recording of up to 10 minutes, in SD or as the camera’s original 4K file. Nothing downloads until you press Save.',
      },
      {
        icon: 'clip',
        title: 'Save clip around',
        text: 'Pick a moment in time and save a video. The proxy builds the clip from the neighbouring recordings, or from stills where nothing was recorded, up to 5 minutes.',
      },
      {
        icon: 'archive',
        title: 'The archive',
        text: 'Archived clips outlast the normal retention: 365 days or forever. Label, sort and filter them, and download a selection as a ZIP.',
      },
    ],
    shots: [
      shot('around', 'The “Save clip around” dialog: pre-roll and post-roll sliders, the size, and what the clip is made of'),
      shot('archive', 'The Archive page: archived clips with thumbnails, recorded time, size, labels and expiry'),
    ],
  },
  {
    id: 'cameras',
    kicker: 'Cameras',
    title: 'Made for Reolink cameras',
    lead: 'We run the Reolink RLC-1224A, a 12-megapixel turret, and use what it offers.',
    features: [
      {
        icon: 'camera',
        title: 'What we use of the RLC-1224A',
        text: 'Its two live streams (SD in H.264, 4K in H.265), the AI detection of people, vehicles and pets, motion and ONVIF events, the recordings on its SD card, clip uploads by FTP, the spotlight and the infrared lights.',
      },
      {
        icon: 'settings',
        title: 'Camera settings from the browser',
        text: 'Rename a camera, choose what it records and how sensitive its detection is, set day and night, lights and on-screen text, or restart it, without the camera’s own web page.',
      },
      {
        icon: 'shield',
        title: 'Measured, not guessed',
        text: 'Every camera behaviour comes from the real device. One example: a setting is always written as a whole, because the camera quietly resets what a partial write leaves out.',
      },
      {
        icon: 'layers',
        title: 'A camera abstraction',
        text: 'cam-sim answers like the RLC-1224A, quirks and failures included, and also models the CX820. It stands in as a camera in production, and every change to the app and the proxy is tested against it.',
      },
    ],
    shots: [shot('settings', 'Camera settings in the browser: recording and detection sensitivity for people, vehicles and pets, image and lights')],
  },
  {
    id: 'proxy',
    kicker: 'Proxy',
    title: 'The proxy does the heavy lifting',
    lead: 'cam-proxy sits next to the cameras and becomes their only client, so the app never wrestles with a camera’s limits.',
    features: [
      {
        icon: 'server',
        title: 'The cameras’ only client',
        text: 'It keeps one connection per camera, stores a still every second, receives the clips by FTP and fetches recordings from the SD card, even where the camera refuses HTTP downloads.',
      },
      {
        icon: 'about',
        title: 'Its own admin UI',
        text: 'On the local network, each proxy has an admin UI: a Status page with a health summary, and pages for events, the timeline, clips, the audit log, settings, maintenance and certificates.',
      },
      {
        icon: 'shield',
        title: 'A site CA',
        text: 'A proxy can run its own certificate authority for the cameras of its site, and the app checks those certificates before it sends a camera login.',
      },
      {
        icon: 'move',
        title: 'Camera moves',
        text: 'Move a camera to another proxy and its recordings, stills, events and archive come along. Every file is checked, and the old proxy deletes only what the new one has verified.',
      },
    ],
    shots: [shot('proxy-status', 'The proxy’s admin UI: the Status page with its health summary and cards for the camera, events, stills, clips, recordings, storage and archive')],
  },
  {
    id: 'hardware',
    kicker: 'Hardware',
    title: 'Scales to the requirements',
    lead: 'The same software on a Raspberry Pi, a mini PC or a Kubernetes cluster.',
    features: [
      {
        icon: 'camera',
        title: 'One camera, one Raspberry Pi',
        text: 'A Raspberry Pi next to the camera runs the proxy and the app on one tiny platform. With a sign-in token it needs no internet, which makes it a demo kit you can carry.',
      },
      {
        icon: 'display',
        title: 'An e-paper status display',
        text: 'A small e-paper screen on the Pi shows the proxy’s health at a glance, without a computer or a login. Four keys flip through camera, proxy and Pi, and the picture stays even without power.',
      },
      {
        icon: 'layers',
        title: 'Larger proxies, many cameras',
        text: 'A mini PC with its own camera network runs one proxy for 10 or more cameras, an account can have several proxies, and one app serves them all. Estimated for a mini PC class machine (Ryzen 5 mobile CPU, 8 GB RAM, 512 GB NVMe SSD); not yet load-tested. The basis: a 4-core Celeron J1900 with 4 GB runs 3 cameras at about 95% idle.',
      },
      {
        icon: 'live',
        title: 'Reach it from anywhere',
        text: 'The app also runs in a Kubernetes cluster, so you can watch from anywhere, while the footage stays with the proxies.',
      },
    ],
  },
  {
    id: 'fleet',
    kicker: 'Fleet',
    title: 'One console for the whole fleet',
    lead: 'cams-admin manages accounts, people, proxies and cameras, with every change on record.',
    features: [
      {
        icon: 'users',
        title: 'Accounts, roles and Google sign-in',
        text: 'People sign in to the app and to the admin console with their Google account (Google OAuth), and only invited accounts get in. Each person has a role per account: viewers watch and download, admins change things.',
      },
      {
        icon: 'about',
        title: 'A live dashboard',
        text: 'See every proxy and camera online or offline as it changes. Proxies connect out to the console, so they need no open port.',
      },
      {
        icon: 'shield',
        title: 'Changes the proxy agrees to',
        text: 'Every remote change is signed, previewed before it applies and can be rolled back. Each proxy decides what the console may do, and every action is in the audit log.',
      },
    ],
    shots: [shot('admin-dashboard', 'The cams-admin dashboard: accounts, proxies and cameras online, the cams instances, and each account’s proxies with their cameras')],
  },
  {
    id: 'open',
    kicker: 'Open',
    title: 'Open source, built with AI',
    lead: 'Your AI can read the code, build new features on the APIs, and manage the system for you from plain-text prompts.',
    features: [
      {
        icon: 'code',
        title: 'All public on GitHub',
        text: 'The app, the proxy, the camera abstraction, the admin console and the e-paper display are open source.',
      },
      {
        icon: 'sparkle',
        title: 'Made with AI',
        text: 'Designed, written, tested and reviewed together with an AI coding agent, from the first line to every release.',
      },
      {
        icon: 'plug',
        title: 'Proxy APIs for your own apps',
        text: 'The proxy’s client API is documented in OpenAPI: cameras, events, stills, clips, SD recordings and the archive, plus a live event stream you can resume.',
      },
      {
        icon: 'chat',
        title: 'Connect your AI assistant',
        text: 'An MCP server gives Claude or any MCP client read access to your cameras, events with their AI labels, recordings, the archive and short clips made on request: pictures it can look at, videos as short-lived links. Each member makes a personal token in Settings, shown once, and you can revoke it at any time; every call is rate-limited and audited.',
      },
      {
        icon: 'bot',
        title: 'A fleet run by an AI',
        text: 'An AI agent looks after the fleet through cams-admin’s APIs: a read-only diagnostics token for what it needs to know, and scoped operations tokens for the few things it may change.',
      },
    ],
  },
];

// The MCP server (cams /mcp): the line that adds it to Claude Code, and its docs.
export const MCP = {
  command: 'claude mcp add --transport http cams https://cams.skylar.technology/mcp --header "Authorization: Bearer cmcp_<your token>"',
  docs: 'https://github.com/klaushofrichter/cams#mcp-server',
  available: 'Available now at cams.skylar.technology/mcp. Create your token under Settings → Assistant access (MCP).',
  // A few of the README's sample prompts, with what comes back (no tool names here).
  prompts: [
    { prompt: 'Was anyone at the garage last night?', hint: 'It goes through the events and looks at their pictures.' },
    { prompt: 'Show me the backyard right now.', hint: 'The current picture, for your assistant to see.' },
    { prompt: 'Make a clip of the garage from 14:10 to 14:12 today.', hint: 'A download link to the clip, valid for 15 minutes.' },
    { prompt: 'How much of the AI check budget is left this month?', hint: 'The Google Vision calls used and left.' },
  ],
};

// cams serves /llms.txt: every API and its documentation, for LLMs. Relative,
// so a local viewer (the Pi, a mini PC) links its own.
export const LLMS_TXT = { href: '/llms.txt', text: 'Point your AI at llms.txt: every API and its documentation in one list.' };

export const REPOS: Repo[] = [
  { name: 'cams', url: 'https://github.com/klaushofrichter/cams', text: 'The app' },
  { name: 'cam-proxy', url: 'https://github.com/klaushofrichter/cam-proxy', text: 'The proxy' },
  { name: 'cam-sim', url: 'https://github.com/klaushofrichter/cam-sim', text: 'The camera abstraction' },
  { name: 'cams-admin', url: 'https://github.com/klaushofrichter/cams-admin', text: 'The admin console' },
  { name: 'cam-proxy-pi-display', url: 'https://github.com/klaushofrichter/cam-proxy-pi-display', text: 'The e-paper display' },
];
