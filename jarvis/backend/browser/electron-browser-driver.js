'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  isNavigationAllowed,
  isSubresourceAllowed,
  parseAllowedOrigins,
  sanitizeUrlForAudit,
} = require('../../core/browser/browser-policy');

const DEFAULT_MAX_ELEMENTS = 30;
const MAX_ELEMENTS = 60;
const PAGE_TEXT_LIMIT = 6000;
const ELEMENT_TEXT_LIMIT = 160;
const ACTION_SETTLE_MS = 5000;
const SCREENSHOT_LIMIT = 100;
const ELEMENT_ID_RE = /^jv_[a-f0-9]{8}_\d{1,3}$/;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampInteger(value, fallback, min, max) {
  const number = Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

function pageTitle(win) {
  try {
    return win.webContents.getTitle() || '';
  } catch {
    return '';
  }
}

class ElectronBrowserDriver {
  constructor({
    BrowserWindow,
    session,
    app,
    partition = 'jarvis-browser',
    artifactsDir = null,
    allowedOrigins = undefined,
    audit = () => {},
    maxScreenshots = SCREENSHOT_LIMIT,
  } = {}) {
    if (!BrowserWindow) throw new Error('ElectronBrowserDriver requires BrowserWindow');
    if (!session || typeof session.fromPartition !== 'function') {
      throw new Error('ElectronBrowserDriver requires the Electron session module');
    }
    if (!app || typeof app.getPath !== 'function') {
      throw new Error('ElectronBrowserDriver requires the Electron app module');
    }

    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.app = app;
    this.partition = partition;
    this.artifactsDir = artifactsDir || path.join(app.getPath('userData'), 'browser-artifacts');
    this.allowedOrigins = Array.isArray(allowedOrigins)
      ? allowedOrigins.slice()
      : parseAllowedOrigins(allowedOrigins);
    this.audit = typeof audit === 'function' ? audit : () => {};
    this.maxScreenshots = clampInteger(maxScreenshots, SCREENSHOT_LIMIT, 1, 500);

    this.window = null;
    this.browserSession = null;
    this.pageUrl = null;
    this.elementIds = new Set();
    this.blockedRequestKeys = new Set();
    this._configuredSession = null;
  }

  _audit(action, detail, verdict = 'ALLOWED') {
    try {
      this.audit(action, String(detail ?? '').slice(0, 500), verdict);
    } catch {
      // Audit must never break browser control.
    }
  }

  _ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const browserSession = this.session.fromPartition(this.partition, { cache: false });
    this.browserSession = browserSession;
    this._configureSession(browserSession);

    const win = new this.BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        paintWhenInitiallyHidden: true,
        spellcheck: false,
        devTools: false,
        webviewTag: false,
      },
    });

    this.window = win;
    this._configureWindow(win);
    return win;
  }

  _configureSession(browserSession) {
    if (this._configuredSession === browserSession) return;
    this._configuredSession = browserSession;

    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', event => {
      event.preventDefault();
      this._audit('BROWSER_DOWNLOAD_BLOCKED', 'download prevented', 'DENY');
    });

    browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const isMainFrame = details.resourceType === 'mainFrame';
      const check = isMainFrame
        ? isNavigationAllowed(details.url, this.allowedOrigins)
        : isSubresourceAllowed(details.url, {
            pageUrl: this.pageUrl,
            allowedOrigins: this.allowedOrigins,
          });

      if (check.ok) {
        callback({});
        return;
      }

      const key = `${details.resourceType}:${sanitizeUrlForAudit(details.url)}`;
      if (!this.blockedRequestKeys.has(key) && this.blockedRequestKeys.size < 100) {
        this.blockedRequestKeys.add(key);
        this._audit(
          isMainFrame ? 'BROWSER_NAVIGATE_BLOCKED' : 'BROWSER_REQUEST_BLOCKED',
          `${key} (${check.error})`,
          'DENY'
        );
      }
      callback({ cancel: true });
    });
  }

  _configureWindow(win) {
    const webContents = win.webContents;

    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.setAudioMuted(true);
    if (typeof webContents.setWebRTCIPHandlingPolicy === 'function') {
      try { webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch { /* best effort */ }
    }

    webContents.on('will-attach-webview', event => event.preventDefault());

    webContents.on('will-navigate', (event, url) => {
      const check = isNavigationAllowed(url, this.allowedOrigins);
      if (!check.ok) {
        event.preventDefault();
        this._audit('BROWSER_NAVIGATE_BLOCKED', `${sanitizeUrlForAudit(url)} (${check.error})`, 'DENY');
        return;
      }
      this.pageUrl = check.url;
    });

    webContents.on('will-redirect', (event, url) => {
      const check = isNavigationAllowed(url, this.allowedOrigins);
      if (!check.ok) {
        event.preventDefault();
        this._audit('BROWSER_REDIRECT_BLOCKED', `${sanitizeUrlForAudit(url)} (${check.error})`, 'DENY');
        return;
      }
      this.pageUrl = check.url;
    });

    webContents.on('did-navigate', (_event, url) => {
      this.pageUrl = url;
    });
    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.pageUrl = url;
    });
    webContents.on('render-process-gone', (_event, details) => {
      this.elementIds.clear();
      this._audit('BROWSER_PROCESS_GONE', details?.reason || 'unknown', 'ERROR');
    });

    win.on('closed', () => {
      if (this.window === win) this.window = null;
      this.elementIds.clear();
    });
  }

  _requireWindow() {
    if (!this.window || this.window.isDestroyed()) {
      throw new Error('Browser is not open. Use browser_navigate first.');
    }
    return this.window;
  }

  async _settle(win) {
    try {
      if (win.webContents.isLoading()) {
        await new Promise(resolve => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            win.webContents.removeListener('did-stop-loading', finish);
            win.webContents.removeListener('did-finish-load', finish);
            resolve();
          };
          const timer = setTimeout(finish, ACTION_SETTLE_MS);
          win.webContents.once('did-stop-loading', finish);
          win.webContents.once('did-finish-load', finish);
        });
      }
      await delay(80);
      if (win.webContents.isLoading()) {
        await new Promise(resolve => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            win.webContents.removeListener('did-stop-loading', finish);
            resolve();
          };
          const timer = setTimeout(finish, ACTION_SETTLE_MS);
          win.webContents.once('did-stop-loading', finish);
        });
      }
    } catch {
      // A destroyed renderer is handled by the caller through the next query.
    }
  }

  async _afterAction(win) {
    await delay(120);
    await this._settle(win);
    return this.read({ includeScreenshot: true, maxElements: DEFAULT_MAX_ELEMENTS });
  }

  async navigate(rawUrl) {
    const check = isNavigationAllowed(rawUrl, this.allowedOrigins);
    if (!check.ok) {
      this._audit('BROWSER_NAVIGATE_BLOCKED', `${sanitizeUrlForAudit(rawUrl)} (${check.error})`, 'DENY');
      throw new Error(check.error);
    }

    const win = this._ensureWindow();
    this.elementIds.clear();
    this.pageUrl = check.url;

    try {
      await win.loadURL(check.url);
    } catch (error) {
      this._audit('BROWSER_NAVIGATE_ERROR', `${sanitizeUrlForAudit(check.url)} (${error.message})`, 'ERROR');
      throw new Error(`Navigation failed: ${error.message}`);
    }

    await this._settle(win);
    return {
      url: sanitizeUrlForAudit(this.pageUrl || check.url),
      title: pageTitle(win),
    };
  }

  async read({ includeScreenshot = true, maxElements = DEFAULT_MAX_ELEMENTS } = {}) {
    const win = this._requireWindow();
    await this._settle(win);

    const snapshotToken = crypto.randomBytes(4).toString('hex');
    const elementLimit = clampInteger(maxElements, DEFAULT_MAX_ELEMENTS, 1, MAX_ELEMENTS);
    const script = `(() => {
      const TOKEN = ${JSON.stringify(snapshotToken)};
      const MAX_ELEMENTS = ${elementLimit};
      const MAX_TEXT = ${PAGE_TEXT_LIMIT};
      const MAX_ELEMENT_TEXT = ${ELEMENT_TEXT_LIMIT};

      const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const textOf = el => clean(el.innerText || el.textContent).slice(0, MAX_ELEMENT_TEXT);
      const safeUrl = value => {
        try {
          const parsed = new URL(value);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
          return parsed.origin + parsed.pathname;
        } catch {
          return null;
        }
      };
      const isVisible = el => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelOf = el => {
        const aria = clean(el.getAttribute('aria-label'));
        if (aria) return aria.slice(0, 120);
        if (el.id) {
          const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          const labelText = clean(label && (label.innerText || label.textContent));
          if (labelText) return labelText.slice(0, 120);
        }
        return clean(
          el.getAttribute('placeholder')
          || el.getAttribute('name')
          || el.getAttribute('title')
          || el.getAttribute('alt')
          || el.innerText
          || el.textContent
        ).slice(0, 120);
      };
      const roleOf = el => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          if (el.type === 'checkbox' || el.type === 'radio') return el.type;
          if (el.type === 'submit' || el.type === 'button') return 'button';
          return 'textbox';
        }
        return tag;
      };

      document.querySelectorAll('[data-jarvis-id]').forEach(el => el.removeAttribute('data-jarvis-id'));

      const selector = 'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]';
      const all = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      const elements = all.slice(0, MAX_ELEMENTS).map((el, index) => {
        const id = 'jv_' + TOKEN + '_' + index;
        el.setAttribute('data-jarvis-id', id);
        const rect = el.getBoundingClientRect();
        const descriptor = {
          id,
          tag: el.tagName.toLowerCase(),
          role: roleOf(el),
          name: labelOf(el),
          nameAttribute: el.getAttribute('name') || null,
          domId: el.id || null,
          text: textOf(el),
          type: el.getAttribute('type') || null,
          href: safeUrl(el.href),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          checked: typeof el.checked === 'boolean' ? el.checked : null,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          descriptor.valueLength = typeof el.value === 'string' ? el.value.length : 0;
        }
        if (el.tagName === 'SELECT') {
          descriptor.options = Array.from(el.options).slice(0, 20).map(option => ({
            text: clean(option.text).slice(0, 80),
            value: String(option.value).slice(0, 80),
            selected: option.selected,
          }));
        }
        return descriptor;
      });

      const rawText = String(document.body && (document.body.innerText || document.body.textContent) || '');
      const normalizedText = rawText
        .replace(/\\r\\n?/g, '\\n')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      return {
        url: safeUrl(location.href),
        title: document.title,
        readyState: document.readyState,
        text: normalizedText.slice(0, MAX_TEXT),
        textTruncated: normalizedText.length > MAX_TEXT,
        elements,
        elementCount: all.length,
        elementsTruncated: all.length > MAX_ELEMENTS,
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.round(document.documentElement.scrollHeight),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    })()`;

    const result = await win.webContents.executeJavaScript(script, false);
    this.elementIds = new Set((result.elements || []).map(element => element.id));

    let screenshotPath = null;
    if (includeScreenshot) {
      screenshotPath = await this._captureScreenshot(win);
    }

    return {
      ...result,
      screenshotPath,
    };
  }

  async preview(elementId, action) {
    this._requireElementId(elementId);
    const win = this._requireWindow();
    const script = this._previewScript(elementId, action);
    const result = await win.webContents.executeJavaScript(script, false);
    return {
      ...result,
      url: sanitizeUrlForAudit(this.pageUrl || win.webContents.getURL()),
    };
  }

  async click(elementId) {
    this._requireElementId(elementId);
    const win = this._requireWindow();
    const target = await win.webContents.executeJavaScript(this._clickScript(elementId), true);
    const snapshot = await this._afterAction(win);
    return {
      action: 'click',
      target: { ...target, url: sanitizeUrlForAudit(this.pageUrl || win.webContents.getURL()) },
      snapshot,
    };
  }

  async type(elementId, text) {
    this._requireElementId(elementId);
    if (typeof text !== 'string' || !text) throw new Error('Text is required');
    if (text.length > 4000) throw new Error('Text exceeds 4000 characters');
    const win = this._requireWindow();
    const target = await win.webContents.executeJavaScript(this._typeScript(elementId, text), true);
    const snapshot = await this._afterAction(win);
    return {
      action: 'type',
      target: { ...target, url: sanitizeUrlForAudit(this.pageUrl || win.webContents.getURL()) },
      snapshot,
    };
  }

  async select(elementId, value) {
    this._requireElementId(elementId);
    if (typeof value !== 'string' || !value) throw new Error('Option value is required');
    if (value.length > 200) throw new Error('Option value exceeds 200 characters');
    const win = this._requireWindow();
    const target = await win.webContents.executeJavaScript(this._selectScript(elementId, value), true);
    const snapshot = await this._afterAction(win);
    return {
      action: 'select',
      target: { ...target, url: sanitizeUrlForAudit(this.pageUrl || win.webContents.getURL()) },
      snapshot,
    };
  }

  async scroll(direction, amount = 600) {
    const win = this._requireWindow();
    const normalizedDirection = ['up', 'down', 'top', 'bottom'].includes(direction) ? direction : 'down';
    const pixels = clampInteger(amount, 600, 1, 5000);
    return win.webContents.executeJavaScript(this._scrollScript(normalizedDirection, pixels), true);
  }

  async stop() {
    const win = this.window;
    this.window = null;
    this.pageUrl = null;
    this.elementIds.clear();

    if (win && !win.isDestroyed()) {
      win.destroy();
    }

    if (this.browserSession) {
      try { await this.browserSession.clearStorageData(); } catch { /* best effort */ }
      try { await this.browserSession.clearCache(); } catch { /* best effort */ }
      this.browserSession = null;
      this._configuredSession = null;
    }

    return { stopped: true };
  }

  close() {
    return this.stop();
  }

  status() {
    if (!this.window || this.window.isDestroyed()) {
      return { open: false, url: null, title: null };
    }
    return {
      open: true,
      url: sanitizeUrlForAudit(this.window.webContents.getURL()),
      title: pageTitle(this.window),
    };
  }

  _requireElementId(elementId) {
    if (typeof elementId !== 'string' || !ELEMENT_ID_RE.test(elementId)) {
      throw new Error('Invalid element id; call browser_read again');
    }
    if (!this.elementIds.has(elementId)) {
      throw new Error('Element id is stale; call browser_read again');
    }
  }

  _previewScript(elementId, action) {
    const normalizedAction = ['click', 'type', 'select'].includes(action) ? action : 'click';
    return `(() => {
      const ACTION = ${JSON.stringify(normalizedAction)};
      const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const safeUrl = value => {
        try {
          const parsed = new URL(value);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
          return parsed.origin + parsed.pathname;
        } catch { return null; }
      };
      const el = document.querySelector('[data-jarvis-id="${elementId}"]');
      if (!el) throw new Error('Element is stale; call browser_read again');
      const rect = el.getBoundingClientRect();
      const label = clean(
        el.getAttribute('aria-label')
        || el.getAttribute('placeholder')
        || el.getAttribute('name')
        || el.getAttribute('title')
        || el.innerText
        || el.textContent
      ).slice(0, 160);
      const descriptor = {
        id: ${JSON.stringify(elementId)},
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: label,
        nameAttribute: el.getAttribute('name') || null,
        domId: el.id || null,
        text: clean(el.innerText || el.textContent).slice(0, 160),
        href: safeUrl(el.href),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        action: ACTION,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        descriptor.valueLength = typeof el.value === 'string' ? el.value.length : 0;
      }
      if (el.tagName === 'SELECT') {
        descriptor.options = Array.from(el.options).slice(0, 20).map(option => ({
          text: clean(option.text).slice(0, 80),
          value: String(option.value).slice(0, 80),
          selected: option.selected,
        }));
      }
      return { element: descriptor };
    })()`;
  }

  _clickScript(elementId) {
    return `(() => {
      const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const el = document.querySelector('[data-jarvis-id="${elementId}"]');
      if (!el) throw new Error('Element is stale; call browser_read again');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Element is disabled');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return {
        id: ${JSON.stringify(elementId)},
        tag: el.tagName.toLowerCase(),
        name: clean(el.getAttribute('aria-label') || el.innerText || el.textContent).slice(0, 160),
      };
    })()`;
  }

  _typeScript(elementId, text) {
    return `(() => {
      const el = document.querySelector('[data-jarvis-id="${elementId}"]');
      if (!el) throw new Error('Element is stale; call browser_read again');
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        throw new Error('Target is not an input or textarea');
      }
      if (el.disabled || el.readOnly) throw new Error('Target is not editable');
      if (el.type === 'file') throw new Error('File inputs are not supported');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(text)});
      else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        id: ${JSON.stringify(elementId)},
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: String(el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '').slice(0, 160),
        valueLength: el.value.length,
      };
    })()`;
  }

  _selectScript(elementId, value) {
    return `(() => {
      const el = document.querySelector('[data-jarvis-id="${elementId}"]');
      if (!el) throw new Error('Element is stale; call browser_read again');
      if (!(el instanceof HTMLSelectElement)) throw new Error('Target is not a select element');
      if (el.disabled) throw new Error('Target is disabled');
      const value = ${JSON.stringify(value)};
      if (!Array.from(el.options).some(option => option.value === value)) {
        throw new Error('Option value was not found');
      }
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        id: ${JSON.stringify(elementId)},
        tag: 'select',
        valueLength: value.length,
        selectedText: String(el.options[el.selectedIndex]?.text || '').trim().slice(0, 80),
      };
    })()`;
  }

  _scrollScript(direction, amount) {
    return `(() => {
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      if (${JSON.stringify(direction)} === 'top') window.scrollTo(0, 0);
      else if (${JSON.stringify(direction)} === 'bottom') window.scrollTo(0, max);
      else window.scrollBy(0, ${JSON.stringify(direction)} === 'up' ? -${amount} : ${amount});
      return {
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.round(document.documentElement.scrollHeight),
        viewportHeight: window.innerHeight,
      };
    })()`;
  }

  async _captureScreenshot(win) {
    try {
      fs.mkdirSync(this.artifactsDir, { recursive: true });
      const bounds = win.getContentBounds();
      const image = await win.webContents.capturePage({
        x: 0,
        y: 0,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      }, { stayHidden: true });
      if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
        this._audit('BROWSER_SCREENSHOT_ERROR', 'empty capture', 'ERROR');
        return null;
      }
      const name = `browser-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.png`;
      const filePath = path.join(this.artifactsDir, name);
      fs.writeFileSync(filePath, image.toPNG());
      this._pruneScreenshots();
      return filePath;
    } catch (error) {
      this._audit('BROWSER_SCREENSHOT_ERROR', error.message, 'ERROR');
      return null;
    }
  }

  _pruneScreenshots() {
    try {
      const entries = fs.readdirSync(this.artifactsDir)
        .filter(name => /^browser-\d+-[a-f0-9]+\.png$/.test(name))
        .map(name => {
          const filePath = path.join(this.artifactsDir, name);
          return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      while (entries.length > this.maxScreenshots) {
        const oldest = entries.shift();
        try { fs.unlinkSync(oldest.filePath); } catch { /* best effort */ }
      }
    } catch {
      // Screenshot retention is best-effort.
    }
  }
}

module.exports = { ElectronBrowserDriver, ELEMENT_ID_RE };
