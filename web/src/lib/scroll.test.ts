// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollIntoContainer } from './scroll';

// jsdom has no scrollIntoView: a stand-in the tests can watch.
Element.prototype.scrollIntoView ??= function () {};

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

describe('scrollIntoContainer', () => {
  // iPhone, 2026-09-29: the list sits below the video and the page scrolls;
  // scrolling the page to a card moved the video off the screen.
  it('scrolls nothing when no parent scrolls on its own (the phone layout)', () => {
    const into = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const toSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const card = document.createElement('div');
    document.body.appendChild(card);
    expect(scrollIntoContainer(card)).toBe(false);
    expect(into).not.toHaveBeenCalled();
    expect(toSpy).not.toHaveBeenCalled();
  });

  it('scrolls only its scrolling parent, just enough (the desktop sidebar)', () => {
    const into = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const box = document.createElement('div');
    box.style.overflowY = 'auto';
    Object.defineProperty(box, 'scrollHeight', { value: 2000 });
    Object.defineProperty(box, 'clientHeight', { value: 400 });
    const card = document.createElement('div');
    box.appendChild(card);
    document.body.appendChild(box);
    box.getBoundingClientRect = () => rect(100, 400);
    card.getBoundingClientRect = () => rect(600, 60); // below the box's view
    box.scrollTop = 0;
    expect(scrollIntoContainer(card)).toBe(true);
    expect(box.scrollTop).toBe(160); // bottom aligned: 600 + 60 - (100 + 400)
    card.getBoundingClientRect = () => rect(40, 60); // above
    box.scrollTop = 500;
    scrollIntoContainer(card);
    expect(box.scrollTop).toBe(440); // top aligned: 500 - (100 - 40)
    card.getBoundingClientRect = () => rect(200, 60); // already visible
    scrollIntoContainer(card);
    expect(box.scrollTop).toBe(440);
    expect(into).not.toHaveBeenCalled();
  });

  // The phone's app content area scrolls too, and holds the video: a
  // scrolling parent outside `within` is never used.
  it('never goes past `within`, even when an outer parent scrolls', () => {
    const outer = document.createElement('main');
    outer.style.overflowY = 'auto';
    Object.defineProperty(outer, 'scrollHeight', { value: 3000 });
    Object.defineProperty(outer, 'clientHeight', { value: 800 });
    const side = document.createElement('aside'); // not scrolling on a phone
    const card = document.createElement('div');
    side.appendChild(card);
    outer.appendChild(side);
    document.body.appendChild(outer);
    outer.getBoundingClientRect = () => rect(0, 800);
    card.getBoundingClientRect = () => rect(1500, 60);
    expect(scrollIntoContainer(card, side)).toBe(false);
    expect(outer.scrollTop).toBe(0);
  });
});
