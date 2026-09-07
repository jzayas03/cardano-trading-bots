import { describe, expect, it } from 'vitest';
import { escape, layout, REHEARSAL_BANNER, statusWord, table } from '../src/html.js';

describe('escape', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escape('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
  it('escapes a bare single quote', () => {
    expect(escape("O'Brien")).toBe('O&#39;Brien');
  });
  it('renders null and undefined as the empty string, never the string "null"/"undefined"', () => {
    expect(escape(null)).toBe('');
    expect(escape(undefined)).toBe('');
  });
  it('stringifies numbers and bigints without escaping anything', () => {
    expect(escape(42)).toBe('42');
    expect(escape(10n)).toBe('10');
    expect(escape(0)).toBe('0');
  });
});

describe('table', () => {
  it('escapes every cell, including headers', () => {
    const html = table(['<h>'], [['<b>onclick</b>']]);
    expect(html).toContain('&lt;h&gt;');
    expect(html).toContain('&lt;b&gt;onclick&lt;/b&gt;');
    expect(html).not.toContain('<h>');
    expect(html).not.toContain('<b>');
  });
  it('renders a plain "none" paragraph for an empty rows array, not an empty table', () => {
    expect(table(['a', 'b'], [])).toBe('<p class="empty">none</p>');
  });
  it('renders null/undefined cells as empty, not the literal string', () => {
    const html = table(['a'], [[null], [undefined]]);
    expect(html).not.toContain('null');
    expect(html).not.toContain('undefined');
  });
  // Finding: table() previously had no way to carry a pre-rendered <span> (e.g. statusWord()), which
  // is why no real page used it. A branded RenderedCell ({ html }) must pass through untouched instead
  // of being escaped a second time.
  it('passes a branded pre-rendered cell (statusWord()) through untouched, without double-escaping it', () => {
    const html = table(['status'], [[statusWord('OK')]]);
    expect(html).toContain('<span class="status status-ok">OK</span>');
    expect(html).not.toContain('&lt;span');
  });
});

describe('layout', () => {
  it('puts the rehearsal banner before the title and body when rehearsal is true', () => {
    const html = layout('Title', '<p>body</p>', { rehearsal: true });
    const bannerIdx = html.indexOf(REHEARSAL_BANNER);
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(html.indexOf('<h1>'));
    expect(bannerIdx).toBeLessThan(html.indexOf('<p>body</p>'));
  });
  it('omits the banner when rehearsal is not set', () => {
    expect(layout('Title', '<p>body</p>')).not.toContain(REHEARSAL_BANNER);
  });
  it('adds a refresh meta tag only when refreshSec is given', () => {
    const withRefresh = layout('T', '<p></p>', { refreshSec: 60 });
    expect(withRefresh).toContain('<meta http-equiv="refresh" content="60">');
    const without = layout('T', '<p></p>');
    expect(without).not.toContain('http-equiv="refresh"');
  });
  it('escapes the title', () => {
    expect(layout('<script>', '<p></p>')).toContain('&lt;script&gt;');
  });

  // IMPORTANT 2 (final review): `chart.ts`'s `chartHtml` emits a bare inline `new uPlot(...)` — a page
  // that never loads uPlot's own script throws `ReferenceError: uPlot is not defined` in a real
  // browser and renders an empty box. `chart: true` must load the script the inline call needs, not
  // merely the stylesheet that was already (silently, uselessly) there.
  it('loads uPlot\'s script and stylesheet only when chart is true', () => {
    const withChart = layout('T', '<p></p>', { chart: true });
    expect(withChart).toContain('<script src="/vendor/uPlot.iife.min.js"></script>');
    expect(withChart).toContain('<link rel="stylesheet" href="/vendor/uPlot.min.css">');
    const without = layout('T', '<p></p>');
    expect(without).not.toContain('uPlot.iife.min.js');
    expect(without).not.toContain('uPlot.min.css');
  });

  // IMPORTANT 5 (final review): `/` linked to nothing, `/runs/:id` linked nowhere, `/universe` was
  // reachable only by typing the path, and an error page had zero links — browser-back was the only
  // way out of any page. `layout()` is the ONE function every page (including every error page — see
  // `server.ts`'s `errorPage`) goes through, so putting the three links here puts them everywhere.
  it('puts links to /, /runs and /universe on every page, before the title', () => {
    const html = layout('Title', '<p>body</p>');
    for (const href of ['href="/"', 'href="/runs"', 'href="/universe"']) {
      expect(html).toContain(href);
      expect(html.indexOf(href)).toBeLessThan(html.indexOf('<h1>'));
    }
  });

  // MINOR (final review): a mixed `/compare` page needs different rehearsal wording than a single
  // run's page (`COMPARE_REHEARSAL_BANNER` vs. the default `REHEARSAL_BANNER`) — `rehearsalText`
  // overrides the wording without changing whether the banner shows at all.
  it('rehearsalText overrides the banner wording when rehearsal is true, and is ignored when rehearsal is not set', () => {
    const overridden = layout('T', '<p></p>', { rehearsal: true, rehearsalText: 'custom wording' });
    expect(overridden).toContain('custom wording');
    expect(overridden).not.toContain(REHEARSAL_BANNER);

    const ignored = layout('T', '<p></p>', { rehearsal: false, rehearsalText: 'custom wording' });
    expect(ignored).not.toContain('custom wording');
  });
});

describe('statusWord', () => {
  // Finding: statusWord() now returns a branded RenderedCell ({ html }), not a bare string, so
  // table() can tell it apart from a plain cell and pass it through unescaped.
  it('contains the literal word and a class named after it, lower-cased', () => {
    const html = statusWord('STOP').html;
    expect(html).toContain('>STOP<');
    expect(html).toContain('status-stop');
  });
  it('renders every accepted word', () => {
    for (const word of ['OK', 'WARN', 'FAIL', 'STALE', 'WATCH', 'STOP', 'LOST'] as const) {
      const html = statusWord(word).html;
      expect(html).toContain(`>${word}<`);
      expect(html).toContain(`status-${word.toLowerCase()}`);
    }
  });
});
