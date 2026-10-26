'use strict';

/**
 * Frozen, typed action dispatcher.
 *
 * A handler can only run when an element names an exact manifest entry. Action
 * IDs and argument values are never used for property lookup; global handler
 * references are captured once, at registry construction, from an explicit
 * allowlist. Unknown IDs, wrong arity, and wrong argument types are rejected.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JarvisActionRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const EVENT_ATTRS = Object.freeze({
    click: 'data-action',
    change: 'data-change',
    input: 'data-input',
    blur: 'data-blur',
    keydown: 'data-keydown-enter',
    dragstart: 'data-dragstart',
    dragend: 'data-dragend',
    dragover: 'data-dragover',
    dragleave: 'data-dragleave',
    drop: 'data-drop',
  });

  const UNTRUSTED_SELECTOR = '[data-untrusted-content], .msg-content, .think-content';
  const TRUSTED_CONTROL_ATTR = 'data-trusted-control';

  const TYPES = Object.freeze({
    s: Object.freeze({ name: 'string', max: 256 }),
    S: Object.freeze({ name: 'string', max: 8192 }),
    i: Object.freeze({ name: 'integer', min: -2147483648, max: 2147483647 }),
    e: Object.freeze({ name: 'event' }),
  });

  function schemaFor(spec) {
    if (typeof spec !== 'string') throw new TypeError('action args must be a schema string');
    const schema = [];
    for (const code of spec) {
      const type = TYPES[code];
      if (!type) throw new Error(`Unknown action argument type: ${code}`);
      schema.push(type);
    }
    return Object.freeze(schema);
  }

  function invalid(reason) {
    return Object.freeze({ ok: false, reason });
  }

  function validateArgs(schema, args) {
    if (!Array.isArray(args) || args.length !== schema.length) {
      return invalid('argument-count');
    }
    for (let index = 0; index < schema.length; index += 1) {
      const type = schema[index];
      const value = args[index];
      if (type.name === 'string') {
        if (typeof value !== 'string' || value.length > type.max) return invalid('argument-type');
      } else if (type.name === 'integer') {
        if (!Number.isInteger(value) || value < type.min || value > type.max) {
          return invalid('argument-type');
        }
      } else if (type.name === 'event') {
        if (!value || typeof value !== 'object' || !value.target) return invalid('argument-type');
      } else {
        return invalid('argument-type');
      }
    }
    return Object.freeze({ ok: true });
  }

  function createRegistry(manifest, {
    globalObject = typeof window !== 'undefined' ? window : null,
    customHandlers = {},
    onDenied = () => {},
    onError = () => {},
  } = {}) {
    if (!manifest || typeof manifest !== 'object') throw new TypeError('manifest is required');
    if (!globalObject) throw new TypeError('globalObject is required');

    const entries = Object.create(null);
    for (const [id, definition] of Object.entries(manifest)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(id)) {
        throw new Error(`Invalid action ID: ${id}`);
      }
      const schema = schemaFor(definition.args || '');
      let handler;
      if (definition.custom === true) {
        handler = customHandlers[id];
        if (typeof handler !== 'function') {
          throw new Error(`No custom handler registered for ${id}`);
        }
      } else {
        const globalName = definition.global || id;
        handler = globalObject[globalName];
        if (typeof handler !== 'function') {
          throw new Error(`No global handler registered for ${id} (${globalName})`);
        }
      }
      entries[id] = Object.freeze({ id, schema, handler });
    }

    const actions = Object.freeze(entries);

    function dispatch(id, extractedArgs = [], event = null) {
      if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(actions, id)) {
        onDenied(id, 'unknown-action');
        return false;
      }
      const action = actions[id];
      let args = [...extractedArgs];
      const eventPositions = action.schema
        .map((type, index) => (type.name === 'event' ? index : -1))
        .filter(index => index >= 0);
      if (eventPositions.length > 1 || (eventPositions.length === 1 && eventPositions[0] > 1)) {
        onDenied(id, 'invalid-event-schema');
        return false;
      }
      if (eventPositions.length === 1) {
        if (eventPositions[0] === 0) args.unshift(event);
        else args.push(event);
      }
      const validated = validateArgs(action.schema, args);
      if (!validated.ok) {
        onDenied(id, validated.reason);
        return false;
      }
      try {
        const result = action.handler(...args);
        if (result && typeof result.catch === 'function') {
          result.catch(error => onError(id, error));
        }
        return true;
      } catch (error) {
        onError(id, error);
        return false;
      }
    }

    return Object.freeze({ actions, dispatch });
  }

  function parseArgJson(value) {
    try {
      return { ok: true, value: JSON.parse(value) };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Extract typed-ish values from explicit data attributes. No attribute value
   * is evaluated; data-arg-json is JSON.parse only, never JavaScript.
   */
  function extractArgs(element) {
    const args = [];
    if (element.hasAttribute('data-arg-json')) {
      const parsed = parseArgJson(element.getAttribute('data-arg-json'));
      if (!parsed.ok) return invalid('bad-json');
      args.push(parsed.value);
    }
    if (element.hasAttribute('data-arg')) args.push(element.getAttribute('data-arg'));
    if (element.hasAttribute('data-arg1')) args.push(element.getAttribute('data-arg1'));
    if (element.hasAttribute('data-arg2')) args.push(element.getAttribute('data-arg2'));
    if (element.hasAttribute('data-col') && element.hasAttribute('data-idx')) {
      args.push(element.getAttribute('data-col'));
      args.push(Number.parseInt(element.getAttribute('data-idx'), 10));
    } else if (element.hasAttribute('data-idx')) {
      args.push(Number.parseInt(element.getAttribute('data-idx'), 10));
    }
    return Object.freeze({ ok: true, args: Object.freeze(args) });
  }

  function findActionElement(target, attribute) {
    return target && typeof target.closest === 'function' ? target.closest(`[${attribute}]`) : null;
  }

  function isBlockedUntrustedControl(element) {
    const container = element.closest(UNTRUSTED_SELECTOR);
    if (!container) return false;
    return element.getAttribute(TRUSTED_CONTROL_ATTR) !== '1';
  }

  function argsForEvent(element, eventName, event) {
    const extracted = extractArgs(element);
    if (!extracted.ok) return extracted;
    let args = [...extracted.args];
    if (eventName === 'input') {
      args.push(String(event.target.value ?? ''));
    } else if (eventName === 'blur') {
      args.push(String(event.target.innerText ?? event.target.value ?? ''));
    }
    return Object.freeze({ ok: true, args: Object.freeze(args) });
  }

  function installDelegatedEvents(documentObject, registry, {
    onDenied = () => {},
  } = {}) {
    if (!documentObject || typeof documentObject.addEventListener !== 'function') {
      throw new TypeError('document is required');
    }
    for (const [eventName, attribute] of Object.entries(EVENT_ATTRS)) {
      documentObject.addEventListener(eventName, event => {
        const element = findActionElement(event.target, attribute);
        if (!element) return;
        if (isBlockedUntrustedControl(element)) {
          onDenied(element.getAttribute(attribute), 'untrusted-target');
          return;
        }
        const extracted = argsForEvent(element, eventName, event);
        if (!extracted.ok) {
          onDenied(element.getAttribute(attribute), extracted.reason);
          return;
        }
        registry.dispatch(element.getAttribute(attribute), extracted.args, event);
      }, eventName === 'blur' ? true : false);
    }
  }

  /**
   * Route links that came from model/web/imported text to the main-process
   * open-external path. Hash links keep their local navigation behavior.
   */
  function installUntrustedLinkGuard(documentObject, openExternal, {
    onDenied = () => {},
  } = {}) {
    if (!documentObject || typeof documentObject.addEventListener !== 'function') {
      throw new TypeError('document is required');
    }
    documentObject.addEventListener('click', event => {
      const target = event.target;
      const anchor = target && typeof target.closest === 'function'
        ? target.closest('a[href]')
        : null;
      if (!anchor || !anchor.closest(UNTRUSTED_SELECTOR)) return;
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('#')) return;
      event.preventDefault();
      let parsed;
      try {
        parsed = new URL(href);
      } catch {
        onDenied(href, 'invalid-link');
        return;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        onDenied(href, 'unsafe-link-scheme');
        return;
      }
      if (typeof openExternal !== 'function') {
        onDenied(href, 'external-open-unavailable');
        return;
      }
      try {
        openExternal(parsed.href);
      } catch (error) {
        onDenied(href, error && error.message ? error.message : 'external-open-failed');
      }
    });
  }

  return Object.freeze({
    EVENT_ATTRS,
    UNTRUSTED_SELECTOR,
    TRUSTED_CONTROL_ATTR,
    TYPES,
    createRegistry,
    installDelegatedEvents,
    installUntrustedLinkGuard,
    extractArgs,
  });
});
