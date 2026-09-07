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
});

describe('statusWord', () => {
  it('contains the literal word and a class named after it, lower-cased', () => {
    const html = statusWord('STOP');
    expect(html).toContain('>STOP<');
    expect(html).toContain('status-stop');
  });
  it('renders every accepted word', () => {
    for (const word of ['OK', 'WARN', 'FAIL', 'STALE', 'WATCH', 'STOP', 'LOST'] as const) {
      const html = statusWord(word);
      expect(html).toContain(`>${word}<`);
      expect(html).toContain(`status-${word.toLowerCase()}`);
    }
  });
});
