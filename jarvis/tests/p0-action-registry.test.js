'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createRegistry,
  installDelegatedEvents,
  installUntrustedLinkGuard,
  UNTRUSTED_SELECTOR,
} = require('../renderer/action-registry');
const manifest = require('../renderer/action-manifest');

const root = path.join(__dirname, '..');

class FakeElement {
  constructor(tagName = 'DIV', attributes = {}, parent = null) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
    this.parent = parent;
    this.classNames = new Set();
    this.value = '';
    this.innerText = '';
  }

  addClass(name) {
    this.classNames.add(name);
    return this;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  matches(selector) {
    if (selector === '[data-untrusted-content]') return this.hasAttribute('data-untrusted-content');
    if (selector.startsWith('.')) return this.classNames.has(selector.slice(1));
    const attrOnly = selector.match(/^\[([\w-]+)\]$/);
    if (attrOnly) return this.hasAttribute(attrOnly[1]);
    const tagAndAttr = selector.match(/^([a-z0-9]+)\[([\w-]+)\]$/i);
    if (tagAndAttr) {
      return this.tagName === tagAndAttr[1].toUpperCase()
        && this.hasAttribute(tagAndAttr[2]);
    }
    return false;
  }

  closest(selector) {
    for (const part of selector.split(',').map(value => value.trim())) {
      if (this.matches(part)) return this;
    }
    return this.parent ? this.parent.closest(selector) : null;
  }
}

function fakeDocument() {
  const listeners = new Map();
  return {
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    emit(name, event) {
      for (const handler of listeners.get(name) || []) handler(event);
    },
  };
}

function clickEvent(target) {
  return {
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test('P0-5 registry: only exact manifest IDs dispatch, with typed arguments', () => {
  const calls = [];
  const registry = createRegistry({
    hello: { args: 's' },
    copyText: { args: 'e', custom: true },
    tick: { args: 'i' },
  }, {
    globalObject: {
      hello: value => calls.push(['hello', value]),
      tick: value => calls.push(['tick', value]),
    },
    customHandlers: {
      copyText: event => calls.push(['copyText', event]),
    },
    onDenied: (id, reason) => calls.push(['denied', id, reason]),
  });

  assert.equal(registry.dispatch('hello', ['world']), true);
  assert.deepEqual(calls.at(-1), ['hello', 'world']);

  assert.equal(registry.dispatch('missing', []), false);
  assert.deepEqual(calls.at(-1), ['denied', 'missing', 'unknown-action']);

  assert.equal(registry.dispatch('toString', []), false);
  assert.deepEqual(calls.at(-1), ['denied', 'toString', 'unknown-action']);

  assert.equal(registry.dispatch('hello', ['too', 'many']), false);
  assert.deepEqual(calls.at(-1), ['denied', 'hello', 'argument-count']);

  assert.equal(registry.dispatch('tick', ['7']), false);
  assert.deepEqual(calls.at(-1), ['denied', 'tick', 'argument-type']);

  const event = { target: {} };
  assert.equal(registry.dispatch('copyText', [], event), true);
  assert.equal(calls.at(-1)[0], 'copyText');
  assert.equal(calls.at(-1)[1], event);
});

test('P0-5 registry: delegated clicks are denied inside untrusted content', () => {
  const documentObject = fakeDocument();
  const calls = [];
  const registry = createRegistry({
    hello: { args: 's' },
    copyText: { args: 'e', custom: true },
  }, {
    globalObject: { hello: value => calls.push(['hello', value]) },
    customHandlers: { copyText: event => calls.push(['copyText', event]) },
    onDenied: (id, reason) => calls.push(['denied', id, reason]),
  });
  installDelegatedEvents(documentObject, registry, {
    onDenied: (id, reason) => calls.push(['delegated-denied', id, reason]),
  });

  const trusted = new FakeElement('BUTTON', {
    'data-action': 'hello',
    'data-arg': 'trusted',
  });
  documentObject.emit('click', clickEvent(trusted));
  assert.deepEqual(calls.at(-1), ['hello', 'trusted']);

  const message = new FakeElement('DIV').addClass('msg-content');
  const injected = new FakeElement('BUTTON', {
    'data-action': 'hello',
    'data-arg': 'injected',
  }, message);
  documentObject.emit('click', clickEvent(injected));
  assert.deepEqual(calls.at(-1), ['delegated-denied', 'hello', 'untrusted-target']);
  assert.equal(calls.some(call => call[0] === 'hello' && call[1] === 'injected'), false);

  const fakeTrust = new FakeElement('BUTTON', {
    'data-action': 'copyText',
    'data-trusted-control': '1',
  }, message);
  documentObject.emit('click', clickEvent(fakeTrust));
  assert.equal(calls.at(-1)[0], 'copyText');

  const unknown = new FakeElement('BUTTON', {
    'data-action': 'runCodeSafe',
  });
  documentObject.emit('click', clickEvent(unknown));
  assert.deepEqual(calls.at(-1), ['denied', 'runCodeSafe', 'unknown-action']);

  const wrongType = new FakeElement('BUTTON', {
    'data-action': 'hello',
    'data-arg-json': '{"unexpected":true}',
  });
  documentObject.emit('click', clickEvent(wrongType));
  assert.deepEqual(calls.at(-1), ['denied', 'hello', 'argument-type']);
});

test('P0-5 links: untrusted links use the explicit external-open path', () => {
  const documentObject = fakeDocument();
  const denied = [];
  const opened = [];
  installUntrustedLinkGuard(documentObject, href => opened.push(href), {
    onDenied: (href, reason) => denied.push([href, reason]),
  });

  const message = new FakeElement('DIV').addClass('msg-content');
  const httpsLink = new FakeElement('A', { href: 'https://example.com/doc?q=1' }, message);
  const httpsEvent = clickEvent(httpsLink);
  documentObject.emit('click', httpsEvent);
  assert.equal(httpsEvent.defaultPrevented, true);
  assert.deepEqual(opened, ['https://example.com/doc?q=1']);

  const jsLink = new FakeElement('A', { href: 'javascript:window.jarvis.close()' }, message);
  const jsEvent = clickEvent(jsLink);
  documentObject.emit('click', jsEvent);
  assert.equal(jsEvent.defaultPrevented, true);
  assert.deepEqual(denied.at(-1), ['javascript:window.jarvis.close()', 'unsafe-link-scheme']);
  assert.equal(opened.length, 1);

  const hashLink = new FakeElement('A', { href: '#section' }, message);
  const hashEvent = clickEvent(hashLink);
  documentObject.emit('click', hashEvent);
  assert.equal(hashEvent.defaultPrevented, false);

  const trustedLink = new FakeElement('A', { href: 'https://example.com/help' });
  const trustedEvent = clickEvent(trustedLink);
  documentObject.emit('click', trustedEvent);
  assert.equal(trustedEvent.defaultPrevented, false);
  assert.equal(opened.length, 1);
});

test('P0-5 manifest: every markup action is declared exactly once', () => {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['dist', 'vendor'].includes(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (/\.(js|html)$/.test(entry.name)) files.push(filePath);
    }
  };
  walk(path.join(root, 'renderer'));

  const actionIds = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /\bdata-(?:action|change|input|blur|keydown-enter|dragstart|dragend|dragover|dragleave|drop)="([^"]+)"/g,
    )) {
      actionIds.add(match[1]);
    }
  }

  const missing = [...actionIds].filter(id => !manifest[id]).sort();
  const extra = Object.keys(manifest)
    .filter(id => !actionIds.has(id) && id !== 'copyCodeBlock')
    .sort();
  assert.deepEqual(missing, []);
  assert.deepEqual(extra, []);

  for (const id of actionIds) {
    assert.match(id, /^[A-Za-z][A-Za-z0-9]{0,63}$/);
    assert.doesNotMatch(id, /[.\[\]]/);
  }
});

test('P0-5 renderer source has no dynamic action resolution or inline HTML handlers', () => {
  const files = [path.join(root, 'renderer', 'renderer.js')];
  const modules = path.join(root, 'renderer', 'modules');
  for (const entry of fs.readdirSync(modules)) {
    if (entry.endsWith('.js')) files.push(path.join(modules, entry));
  }

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bresolveAndCall\b/);
    assert.doesNotMatch(source, /\bjarvisApi\b/);
    assert.doesNotMatch(source, /\bwindow\s*\[/);
    assert.doesNotMatch(source, /\bglobalThis\s*\[/);
    assert.doesNotMatch(source, /\son(?:click|change|input|blur|keydown|load|error)\s*=\s*["']/i);
    assert.doesNotMatch(source, /data-action\s*=\s*["'][^"']*\$\{/);
  }

  const registrySource = fs.readFileSync(path.join(root, 'renderer', 'action-registry.js'), 'utf8');
  assert.doesNotMatch(registrySource, /\beval\s*\(/);
  assert.doesNotMatch(registrySource, /\bFunction\s*\(/);
  assert.match(registrySource, /hasOwnProperty\.call\(actions, id\)/);
});

test('P0-5 sanitizer: fallback and policy strip executable UI attributes', () => {
  const originalPurifier = globalThis.DOMPurify;
  try {
    delete globalThis.DOMPurify;
    delete require.cache[require.resolve('../renderer/untrusted-content')];
    const safeHtml = require('../renderer/untrusted-content');

    const escaped = safeHtml.sanitize('<button data-action="windowClose">CLOSE</button>');
    assert.match(escaped, /^<p>&lt;button/);
    assert.doesNotMatch(escaped, /<button/i);
    assert.doesNotMatch(escaped, /data-action="/);

    const hooks = [];
    let seenOptions = null;
    globalThis.DOMPurify = {
      addHook(name, handler) { hooks.push([name, handler]); },
      sanitize(html, options) {
        seenOptions = options;
        return '<div>sanitized</div>';
      },
    };

    delete require.cache[require.resolve('../renderer/untrusted-content')];
    const safeWithPurifier = require('../renderer/untrusted-content');
    assert.equal(safeWithPurifier.sanitize('<div>input</div>'), '<div>sanitized</div>');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0][0], 'afterSanitizeAttributes');
    assert.equal(seenOptions.ALLOW_DATA_ATTR, false);
    assert.ok(seenOptions.FORBID_TAGS.includes('script'));
    assert.ok(seenOptions.FORBID_TAGS.includes('svg'));
    assert.ok(seenOptions.FORBID_TAGS.includes('iframe'));
    assert.ok(seenOptions.FORBID_ATTR.includes('data-action'));
    assert.ok(seenOptions.FORBID_ATTR.includes('onclick'));

    const attributes = new Map([
      ['data-action', 'windowClose'],
      ['data-change', 'secToggle'],
      ['data-arg', 'windowClose'],
      ['onclick', 'window.jarvis.close()'],
      ['onload', 'window.jarvis.close()'],
      ['style', 'position:fixed'],
      ['id', 'clobber'],
      ['href', 'javascript:window.jarvis.close()'],
      ['target', '_blank'],
      ['rel', 'opener'],
    ]);
    const link = {
      nodeType: 1,
      tagName: 'A',
      attributes: [...attributes].map(([name, value]) => ({ name, value })),
      hasAttribute: name => attributes.has(name),
      getAttribute: name => attributes.get(name) || null,
      removeAttribute: name => attributes.delete(name),
      setAttribute: (name, value) => attributes.set(name, String(value)),
    };
    hooks[0][1](link);
    assert.equal(attributes.has('data-action'), false);
    assert.equal(attributes.has('data-change'), false);
    assert.equal(attributes.has('data-arg'), false);
    assert.equal(attributes.has('onclick'), false);
    assert.equal(attributes.has('onload'), false);
    assert.equal(attributes.has('style'), false);
    assert.equal(attributes.has('id'), false);
    assert.equal(attributes.has('href'), false);

    assert.equal(safeWithPurifier.SAFE_HREF.test('https://example.com'), true);
    assert.equal(safeWithPurifier.SAFE_HREF.test('#local'), true);
    for (const unsafe of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/x', 'mailto:a@b.c']) {
      assert.equal(safeWithPurifier.SAFE_HREF.test(unsafe), false, unsafe);
    }
  } finally {
    if (originalPurifier === undefined) delete globalThis.DOMPurify;
    else globalThis.DOMPurify = originalPurifier;
    delete require.cache[require.resolve('../renderer/untrusted-content')];
  }
});

test('P0-5 sanitizer: only documented untrusted containers are guarded by default', () => {
  assert.match(UNTRUSTED_SELECTOR, /\.msg-content/);
  assert.match(UNTRUSTED_SELECTOR, /\.think-content/);
  assert.match(UNTRUSTED_SELECTOR, /\[data-untrusted-content\]/);
});
