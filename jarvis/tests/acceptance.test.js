'use strict';

// Phase 1 acceptance scenarios: durable approvals, restart recovery, and
// fail-closed tool policy across the real runtime stack (no Electron, no live
// model). Each test uses the actual TaskStore, ToolRegistry, PolicyEngine, and
// AgentRuntime so the pieces are exercised together rather than in isolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore } = require('../core/runtime/task-store');
const { AgentRuntime } = require('../core/runtime/agent-runtime');
const { TASK_STATUS } = require('../core/runtime/task-state');
const { PromptBuilder } = require('../core/context/prompt-builder');
const { ToolRegistry } = require('../core/tools/tool-registry');
const { PolicyEngine } = require('../core/policy/policy-engine');

function makeSkillsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-acceptance-skills-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  const manifest = {
    version: '1.0',
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echo text',
        script: 'echo.js',
        type: 'js',
        risk: 'read',
        params: { text: { type: 'string', required: true } },
      },
      {
        id: 'write_note',
        name: 'Write Note',
        description: 'Write a note to disk',
        script: 'write_note.js',
        type: 'js',
        risk: 'write',
        params: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      {
        id: 'web_read',
        name: 'Web Read',
        description: 'Read untrusted external data',
        script: 'echo.js',
        type: 'js',
        risk: 'read',
        untrusted: true,
        params: { text: { type: 'string', required: true } },
      },
    ],
  };

  const manifestRaw = JSON.stringify(manifest);
  const signature = crypto.sign(null, Buffer.from(manifestRaw), privateKey);
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestRaw);
  fs.writeFileSync(path.join(dir, 'manifest.sig'), signature);
  fs.writeFileSync(path.join(dir, 'echo.js'), `
    const args = JSON.parse(process.argv[2] || '{}');
    console.log(JSON.stringify({ ok: true, result: 'echo:' + args.text }));
  `);
  fs.writeFileSync(path.join(dir, 'write_note.js'), `
    const fs = require('fs');
    const path = require('path');
    const args = JSON.parse(process.argv[2] || '{}');
    fs.mkdirSync(path.dirname(args.path), { recursive: true });
    fs.writeFileSync(args.path, args.content);
    console.log(JSON.stringify({ ok: true, result: 'wrote:' + args.path }));
  `);

  return { dir, publicPem };
}

function createFakeModel(responses) {
  const calls = [];
  return {
    calls,
    async chat(request) {
      calls.push(request);
      if (responses.length === 0) throw new Error('Fake model has no scripted response');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

async function createHarness({ responses }) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-acceptance-store-'));
  const skills = makeSkillsDir();
  const store = new TaskStore({ baseDir });
  await store.init();

  const registry = new ToolRegistry({ skillsDir: skills.dir, publicKeyPem: skills.publicPem });
  const loaded = await registry.load();
  assert.equal(loaded.ok, true);

  const policy = new PolicyEngine({ taskStore: store });
  const model = createFakeModel(responses);
  const runtime = new AgentRuntime({
    store,
    model,
    promptBuilder: new PromptBuilder(),
    tools: registry,
    policy,
  });

  return {
    baseDir,
    skillsDir: skills.dir,
    store,
    registry,
    policy,
    runtime,
    model,
    cleanup() {
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(skills.dir, { recursive: true, force: true });
    },
  };
}

test('persists a pending write approval and resumes it after a restart', async () => {
  const notePath = path.join(os.tmpdir(), `jarvis-note-${Date.now()}.txt`);
  const harness = await createHarness({
    responses: [
      {
        text: 'I need to write a note.',
        toolCalls: [{
          id: 'call_1',
          name: 'write_note',
          arguments: { path: notePath, content: 'hello from the durable runtime' },
        }],
        finishReason: 'tool_calls',
      },
    ],
  });

  try {
    const task = await harness.store.createTask({ goal: 'Write a note to disk' });
    const paused = await harness.runtime.runTask(task.id, {});
    assert.equal(paused.status, TASK_STATUS.WAITING_APPROVAL);
    assert.equal(paused.approvals.length, 1);
    assert.equal(paused.approvals[0].status, 'pending');
    assert.equal(fs.existsSync(notePath), false, 'write must not run before approval');

    // Simulate a renderer/app restart: discard the runtime, keep the store.
    const restartedModel = createFakeModel([
      { text: 'The note is written.', toolCalls: [], finishReason: 'stop' },
    ]);
    const restartedRuntime = new AgentRuntime({
      store: harness.store,
      model: restartedModel,
      promptBuilder: new PromptBuilder(),
      tools: harness.registry,
      policy: harness.policy,
    });

    const completed = await restartedRuntime.approveTask(task.id, {
      approved: true,
      context: { modelOptions: { num_predict: 64 } },
    });

    assert.equal(completed.status, TASK_STATUS.COMPLETED);
    assert.equal(completed.result, 'The note is written.');
    assert.equal(fs.readFileSync(notePath, 'utf8'), 'hello from the durable runtime');
    assert.equal(completed.approvals[0].status, 'approved');
    assert.equal(typeof completed.approvals[0].consumedAt, 'number');

    const events = await harness.store.readEvents(task.id);
    assert.equal(events.some(event => event.type === 'approval.requested'), true);
    assert.equal(events.some(event => event.type === 'tool.completed'), true);
  } finally {
    fs.rmSync(notePath, { force: true });
    harness.cleanup();
  }
});

test('recovers an orphaned running task and resumes it to completion', async () => {
  const harness = await createHarness({
    responses: [
      { text: 'Recovered and finished.', toolCalls: [], finishReason: 'stop' },
    ],
  });

  try {
    const task = await harness.store.createTask({ goal: 'Survive a crash' });
    await harness.store.transition(task.id, TASK_STATUS.RUNNING);
    await harness.store.updateTask(task.id, draft => {
      draft.stepCount = 1;
      draft.steps.push({
        id: 'step_orphan',
        index: 1,
        kind: 'model',
        status: 'started',
        startedAt: Date.now(),
      });
    });

    const recovered = await harness.runtime.runTask(task.id, {});
    assert.equal(recovered.status, TASK_STATUS.COMPLETED);

    const events = await harness.store.readEvents(task.id);
    assert.equal(events.some(event => event.type === 'runtime.recovered'), true);

    const steps = recovered.steps;
    assert.equal(steps.find(step => step.id === 'step_orphan').status, 'unknown');
    assert.equal(recovered.messages.some(message => message.content.includes('RUNTIME NOTICE')), true);
  } finally {
    harness.cleanup();
  }
});

test('denies an unknown tool without spawning it and continues the loop', async () => {
  const harness = await createHarness({
    responses: [
      {
        text: 'Trying an unknown tool.',
        toolCalls: [{ id: 'call_1', name: 'does_not_exist', arguments: {} }],
        finishReason: 'tool_calls',
      },
      { text: 'Handled without that tool.', toolCalls: [], finishReason: 'stop' },
    ],
  });

  try {
    const task = await harness.store.createTask({ goal: 'Use a tool that does not exist' });
    const completed = await harness.runtime.runTask(task.id, {});

    assert.equal(completed.status, TASK_STATUS.COMPLETED);
    assert.equal(completed.result, 'Handled without that tool.');
    assert.equal(completed.steps.some(step => step.tool === 'does_not_exist' && step.status === 'failed'), true);
    assert.equal(completed.messages.some(message => message.content.includes('unknown-tool')), true);
    assert.equal(completed.tainted, false);
  } finally {
    harness.cleanup();
  }
});

test('requires approval for a tainted task before any further tool call', async () => {
  const harness = await createHarness({
    responses: [
      {
        text: 'Reading external data.',
        toolCalls: [{ id: 'call_1', name: 'web_read', arguments: { text: 'external' } }],
        finishReason: 'tool_calls',
      },
      {
        text: 'Reading again after external data.',
        toolCalls: [{ id: 'call_2', name: 'echo', arguments: { text: 'internal' } }],
        finishReason: 'tool_calls',
      },
    ],
  });

  try {
    const task = await harness.store.createTask({ goal: 'Read then write' });
    const waiting = await harness.runtime.runTask(task.id, {});

    assert.equal(waiting.status, TASK_STATUS.WAITING_APPROVAL);
    assert.equal(waiting.tainted, true);
    assert.equal(waiting.approvals[0].reason, 'tainted-task');
  } finally {
    harness.cleanup();
  }
});
