'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowserTools } = require('../core/browser/browser-tools');
const { ToolRegistry } = require('../core/tools/tool-registry');

function makeFakeDriver() {
  const calls = [];
  const snapshot = {
    url: 'https://example.com/dashboard',
    title: 'Fixture Dashboard',
    text: 'Visible page text',
    elements: [{ id: 'jv_abcd1234_0', tag: 'button', name: 'Continue' }],
    screenshotPath: 'C:/temp/browser-shot.png',
  };

  return {
    calls,
    snapshot,
    async navigate(url) {
      calls.push({ method: 'navigate', url });
      return { url: 'https://example.com/dashboard', title: 'Fixture Dashboard' };
    },
    async read(options) {
      calls.push({ method: 'read', options });
      return snapshot;
    },
    async preview(elementId, action) {
      calls.push({ method: 'preview', elementId, action });
      return {
        url: 'https://example.com/dashboard',
        element: { id: elementId, name: 'Continue', action },
      };
    },
    async click(elementId) {
      calls.push({ method: 'click', elementId });
      return {
        action: 'click',
        target: { id: elementId, name: 'Continue' },
        snapshot,
      };
    },
    async type(elementId, text) {
      calls.push({ method: 'type', elementId, text });
      return {
        action: 'type',
        target: { id: elementId, name: 'Name', valueLength: text.length },
        snapshot,
      };
    },
    async select(elementId, value) {
      calls.push({ method: 'select', elementId, value });
      return {
        action: 'select',
        target: { id: elementId, selectedText: 'Blue' },
        snapshot,
      };
    },
    async scroll(direction, amount) {
      calls.push({ method: 'scroll', direction, amount });
      return { scrollY: 600, scrollHeight: 2400, viewportHeight: 900 };
    },
    async stop() {
      calls.push({ method: 'stop' });
      return { stopped: true };
    },
    async status() {
      return { open: true, url: snapshot.url, title: snapshot.title };
    },
  };
}

function makeTools() {
  const driver = makeFakeDriver();
  const audit = [];
  const tools = createBrowserTools({
    driver,
    audit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
  });
  return {
    audit,
    driver,
    tools,
    byId: new Map(tools.map(tool => [tool.id, tool])),
  };
}

test('browser tools expose read, action, preview, and stop boundaries', () => {
  const { byId } = makeTools();
  assert.deepEqual([...byId.keys()], [
    'browser_navigate',
    'browser_read',
    'browser_preview_action',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_scroll',
    'browser_emergency_stop',
  ]);

  assert.equal(byId.get('browser_read').risk, 'read');
  assert.equal(byId.get('browser_read').untrusted, true);
  assert.equal(byId.get('browser_click').risk, 'write');
  assert.equal(byId.get('browser_type').risk, 'write');
  assert.equal(byId.get('browser_select').risk, 'write');
  assert.equal(byId.get('browser_emergency_stop').alwaysAllow, true);
  assert.equal(byId.get('browser_emergency_stop').risk, 'read');
});

test('navigation and read tools audit safely without query strings or page text', async () => {
  const { audit, byId, driver } = makeTools();

  const navigated = await byId.get('browser_navigate').execute({
    url: 'https://example.com/a?token=supersecret',
  });
  assert.equal(navigated.ok, true);
  assert.equal(driver.calls.at(-1).method, 'navigate');
  assert.ok(audit.some(entry => entry.action === 'BROWSER_NAVIGATE'));
  assert.ok(!JSON.stringify(audit).includes('supersecret'));

  const read = await byId.get('browser_read').execute({ include_screenshot: true });
  assert.equal(read.ok, true);
  assert.equal(read.taint, true);
  assert.equal(read.result.screenshotPath, driver.snapshot.screenshotPath);
  assert.ok(audit.some(entry => entry.action === 'BROWSER_READ'));
  assert.ok(!JSON.stringify(audit).includes('Visible page text'));
});

test('write tools require the intended arguments and redact typed text from audit', async () => {
  const { audit, byId, driver } = makeTools();

  const typed = await byId.get('browser_type').execute({
    element_id: 'jv_abcd1234_0',
    text: 'hunter2-secret',
  });
  assert.equal(typed.ok, true);
  assert.equal(driver.calls.at(-1).method, 'type');
  assert.equal(driver.calls.at(-1).text, 'hunter2-secret');
  assert.ok(audit.some(entry => entry.action === 'BROWSER_TYPE'));
  assert.ok(!JSON.stringify(audit).includes('hunter2-secret'));

  const selected = await byId.get('browser_select').execute({
    element_id: 'jv_abcd1234_0',
    value: 'blue',
  });
  assert.equal(selected.ok, true);
  assert.equal(driver.calls.at(-1).method, 'select');
});

test('dry-run preview never performs the click', async () => {
  const { byId, driver } = makeTools();
  const result = await byId.get('browser_click').execute({
    element_id: 'jv_abcd1234_0',
    dry_run: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.element.name, 'Continue');
  assert.equal(driver.calls.at(-1).method, 'preview');
  assert.ok(!driver.calls.some(call => call.method === 'click'));
});

test('emergency stop closes the driver without needing a page', async () => {
  const { byId, driver } = makeTools();
  const result = await byId.get('browser_emergency_stop').execute({});
  assert.equal(result.ok, true);
  assert.equal(result.result.stopped, true);
  assert.equal(driver.calls.at(-1).method, 'stop');
});

test('tool registry preserves the alwaysAllow emergency-stop flag', async () => {
  const { tools } = makeTools();
  const registry = new ToolRegistry({
    skillsDir: __dirname,
    loadManifest: async () => ({ ok: true, skills: [] }),
    nativeTools: tools,
  });
  await registry.load();

  const stop = registry.getSkill('browser_emergency_stop');
  const click = registry.getSkill('browser_click');
  assert.equal(stop.alwaysAllow, true);
  assert.equal(click.alwaysAllow, false);
  assert.equal(click.risk, 'write');
});
