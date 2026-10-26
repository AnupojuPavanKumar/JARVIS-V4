'use strict';

/**
 * Sanitization boundary for model/web/source text rendered into the DOM.
 *
 * Untrusted HTML never keeps action attributes, event handlers, forms, frames,
 * SVG/MathML, styles, ids/names (DOM clobbering), or non-approved URL schemes.
 * If DOMPurify is unavailable the input is escaped instead of passed through.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.JarvisSafeHtml = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const ACTION_ATTRIBUTES = Object.freeze([
    'data-action', 'data-change', 'data-input', 'data-blur', 'data-keydown-enter',
    'data-dragstart', 'data-dragend', 'data-dragover', 'data-dragleave', 'data-drop',
    'data-arg', 'data-arg1', 'data-arg2', 'data-arg-json', 'data-col', 'data-idx',
    'data-sec-key', 'data-trusted-control', 'data-untrusted-content',
  ]);

  const ALLOWED_TAGS = Object.freeze([
    'a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
    'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins', 'kbd', 'li', 'ol',
    'p', 'pre', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var',
  ]);

  const ALLOWED_ATTR = Object.freeze([
    'class', 'href', 'title', 'target', 'rel', 'colspan', 'rowspan', 'start', 'open',
  ]);

  const SAFE_HREF = /^(?:https?:|#)/i;
  const UNSAFE_ATTRS = Object.freeze([
    'style', 'src', 'srcset', 'id', 'name', 'formaction', 'action', 'method',
    'xlink:href', 'xmlns', 'is', 'srcdoc', 'ping', 'onclick', 'onload', 'onerror',
  ]);

  const hookedPurifiers = new WeakSet();

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripUnsafeAttributes(node) {
    if (!node || node.nodeType !== 1) return;
    for (const name of ACTION_ATTRIBUTES) node.removeAttribute(name);
    for (const name of UNSAFE_ATTRS) node.removeAttribute(name);
    for (const attribute of Array.from(node.attributes || [])) {
      if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    }
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      if (href && !SAFE_HREF.test(href)) {
        node.removeAttribute('href');
        node.removeAttribute('target');
        node.removeAttribute('rel');
      } else if (href) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  function installHooks(purifier) {
    if (hookedPurifiers.has(purifier)) return;
    hookedPurifiers.add(purifier);
    purifier.addHook('afterSanitizeAttributes', stripUnsafeAttributes);
  }

  function sanitize(html) {
    const purify = root.DOMPurify;
    if (!purify || typeof purify.sanitize !== 'function') {
      return `<p>${escapeHtml(html)}</p>`;
    }
    try {
      installHooks(purify);
      return purify.sanitize(String(html == null ? '' : html), {
        ALLOWED_TAGS: [...ALLOWED_TAGS],
        ALLOWED_ATTR: [...ALLOWED_ATTR],
        ALLOW_ARIA_ATTR: false,
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: [
          'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
          'textarea', 'select', 'option', 'svg', 'math', 'template', 'meta', 'link',
          'base', 'img', 'picture', 'video', 'audio', 'source', 'track', 'canvas',
          'map', 'area', 'frame', 'frameset', 'applet', 'marquee', 'noscript',
        ],
        FORBID_ATTR: [...ACTION_ATTRIBUTES, ...UNSAFE_ATTRS],
        ALLOWED_URI_REGEXP: SAFE_HREF,
        RETURN_TRUSTED_TYPE: false,
        USE_PROFILES: { html: true },
      });
    } catch {
      return `<p>${escapeHtml(html)}</p>`;
    }
  }

  return Object.freeze({
    ACTION_ATTRIBUTES,
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    SAFE_HREF,
    escapeHtml,
    sanitize,
    stripUnsafeAttributes,
  });
});
