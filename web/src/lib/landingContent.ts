// The landing page's copy: the highlights strip and the feature sections.
// Public and pre-login, so no addresses, host names, ids or tokens
// (landingContent.test.ts). Claim only what has shipped in cams, cam-proxy,
// cams-admin and cam-proxy-pi-display.
import type { IconName } from './icons';

export interface Highlight {
  icon: IconName;
  title: string;
  text: string;
}

export interface Feature {
  icon: IconName;
  title: string;
  text: string;
}

export interface Section {
  id: string;
  kicker: string;
  title: string;
  lead: string;
  features: Feature[];
}

export const HIGHLIGHTS: Highlight[] = [
  { icon: 'live', title: 'Live in one click', text: 'Every camera live in your browser, in SD or full 4K.' },
  { icon: 'person', title: 'Events that explain themselves', text: 'People, vehicles and pets are labelled the moment they show up.' },
  { icon: 'timeline', title: 'Every second on record', text: 'A still for each second, laid out minute by minute.' },
  { icon: 'clip', title: 'The clip you need', text: 'Save a recording, or build one around any second.' },
  { icon: 'archive', title: 'Keep what matters', text: 'An archive that holds clips for a year, or for good.' },
  { icon: 'shield', title: 'Your hardware, your network', text: 'A small gateway next to your cameras keeps the footage local.' },
];

export const SECTIONS: Section[] = [
  {
    id: 'watch',
    kicker: 'Watch',
    title: 'See it as it happens',
    lead: 'Open the page and the picture is there. Move back in time with one drag.',
    features: [
      {
        icon: 'live',
        title: 'Live video',
        text: 'Watch live in SD or 4K, turn on the sound or the camera’s light, and take a snapshot. If the stream stalls, a fresh still every second fills in.',
      },
      {
        icon: 'history',
        title: 'One strip for the whole day',
        text: 'Drag the strip to go back. Playback runs through clips and stills in real time, and the right end is always live. Zoom from 24 hours down to 30 minutes.',
      },
      {
        icon: 'expand',
        title: 'Fullscreen, with gestures',
        text: 'Step by 1 or 10 seconds, jump to the next event, or go back to live. On the phone, swipe and tap. On the desktop, use the keyboard.',
      },
    ],
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
        text: 'Each event shows a thumbnail from the moment of detection and counts what the camera saw. Filter for people, vehicles, pets or motion.',
      },
      {
        icon: 'sparkle',
        title: 'A second opinion from Google Vision',
        text: 'Optionally, Google Vision checks each event and shows its confidence, with boxes around what it found. You can also check any single second by hand, within a monthly budget.',
      },
      {
        icon: 'timeline',
        title: 'A timeline of stills',
        text: 'One tile per minute, sixty stills per minute. Step second by second, then open that moment in the player.',
      },
      {
        icon: 'motion',
        title: 'News arrives at once',
        text: 'A new event appears in the list as it is recorded. No reloading, no waiting.',
      },
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
        title: 'Save a clip around any second',
        text: 'Pick a second and choose how much comes before and after. The clip is built from the neighbouring recordings, or from the stills where there was no recording, up to 5 minutes.',
      },
      {
        icon: 'archive',
        title: 'The archive',
        text: 'Archived clips stay after the camera’s normal retention: for 365 days or forever. Label them, sort and filter, and download a selection as a ZIP.',
      },
    ],
  },
  {
    id: 'site',
    kicker: 'Run',
    title: 'Built for real sites',
    lead: 'A local gateway does the heavy lifting, so the cameras stay simple and private.',
    features: [
      {
        icon: 'server',
        title: 'One gateway, several cameras',
        text: 'The gateway is your cameras’ only client. It keeps the stills, receives clips and fetches recordings straight from each camera’s memory card.',
      },
      {
        icon: 'shield',
        title: 'Its own certificate authority',
        text: 'A gateway can run its own certificate authority for the cameras of its site, and the viewer checks those certificates before it sends a camera login.',
      },
      {
        icon: 'move',
        title: 'Move a camera, recordings included',
        text: 'Move a camera to another gateway and its recordings, stills, events and archive come along. Every file is checked, and the old gateway deletes only what the new one has verified.',
      },
      {
        icon: 'settings',
        title: 'Camera settings from the browser',
        text: 'Rename a camera, change its settings or restart it without opening the camera’s own web page.',
      },
    ],
  },
  {
    id: 'manage',
    kicker: 'Manage',
    title: 'One console for the whole fleet',
    lead: 'Accounts, people, gateways and cameras in one place, with every change on record.',
    features: [
      {
        icon: 'users',
        title: 'Accounts and roles',
        text: 'Invite people as viewers, who watch and download, or as admins, who change things. One person can belong to several accounts.',
      },
      {
        icon: 'about',
        title: 'A live dashboard',
        text: 'See every gateway and camera online or offline as it changes. Gateways connect out, so they need no open port.',
      },
      {
        icon: 'shield',
        title: 'Changes the gateway agrees to',
        text: 'Every remote change is signed, previewed before it applies and can be rolled back. Each gateway decides what the console may do, and every action is in the audit log.',
      },
    ],
  },
  {
    id: 'anywhere',
    kicker: 'Anywhere',
    title: 'At home, on the road, on the desk',
    lead: 'The same viewer in the cloud, on a small local box, or on your phone.',
    features: [
      {
        icon: 'phone',
        title: 'Made for the phone too',
        text: 'Every page works on a phone, and added to the home screen it opens like an app. Light and dark themes follow your system, or your choice.',
      },
      {
        icon: 'logout',
        title: 'Simple, safe sign-in',
        text: 'Sign in with Google. Local viewers use a sign-in token instead, so they work without the internet.',
      },
      {
        icon: 'camera',
        title: 'A demo kit in a bag',
        text: 'A Raspberry Pi and a camera are the whole system: gateway and viewer on one small board, ready to show anywhere.',
      },
      {
        icon: 'display',
        title: 'Status at a glance',
        text: 'An e-paper display on the Pi answers “is everything fine?” without a computer or a login. Four keys flip through camera, gateway and Pi, and the picture stays even without power.',
      },
    ],
  },
];
