'use strict';

const { validateArgs } = require('../../agent-policy');
const { loadVerifiedSkillsManifest, SKILLS_PUBLIC_KEY_PEM } = require('../skills/manifest');
const { executeSkill } = require('../skills/executor');
const { PromptBuilder } = require('../context/prompt-builder');

function normalizeNativeTool(tool, index) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    throw new Error(`nativeTools[${index}] must be an object`);
  }
  const id = typeof tool.id === 'string' ? tool.id.trim() : '';
  if (!id || !/^[A-Za-z0-9._:-]{1,120}$/.test(id)) {
    throw new Error(`nativeTools[${index}] has an invalid id`);
  }
  if (typeof tool.execute !== 'function') {
    throw new Error(`nativeTools[${index}] must provide an execute function`);
  }

  return {
    id,
    name: typeof tool.name === 'string' && tool.name.trim() ? tool.name.trim() : id,
    description: typeof tool.description === 'string' ? tool.description : '',
    risk: typeof tool.risk === 'string' && tool.risk ? tool.risk : 'read',
    untrusted: Boolean(tool.untrusted),
    alwaysAllow: Boolean(tool.alwaysAllow),
    params: tool.params && typeof tool.params === 'object' && !Array.isArray(tool.params)
      ? tool.params
      : {},
    source: 'native',
    execute: tool.execute,
  };
}

// Verified skill catalog plus trusted built-in tools. The runtime treats this
// as its tool boundary; policy authorization happens before execute() is
// called. Native tools are application code, not user-editable skills, and use
// the same argument validation and read/write risk labels.
class ToolRegistry {
  constructor({
    skillsDir,
    publicKeyPem = SKILLS_PUBLIC_KEY_PEM,
    loadManifest = loadVerifiedSkillsManifest,
    execute = executeSkill,
    promptBuilder = new PromptBuilder(),
    spawnImpl = undefined,
    timeoutMs = 10000,
    nativeTools = [],
  } = {}) {
    if (typeof skillsDir !== 'string' || !skillsDir.trim()) {
      throw new Error('ToolRegistry requires skillsDir');
    }
    if (typeof loadManifest !== 'function') {
      throw new Error('ToolRegistry requires a manifest loader');
    }
    if (typeof execute !== 'function') {
      throw new Error('ToolRegistry requires an executor');
    }
    if (!Array.isArray(nativeTools)) {
      throw new Error('nativeTools must be an array');
    }

    this.skillsDir = skillsDir;
    this.publicKeyPem = publicKeyPem;
    this.loadManifest = loadManifest;
    this.executeImpl = execute;
    this.promptBuilder = promptBuilder;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.nativeTools = nativeTools.map(normalizeNativeTool);

    this._skills = [];
    this._skillMap = new Map();
    this._toolMap = new Map();
    this._definitions = [];
    this.loaded = false;
  }

  _clear() {
    this._skills = [];
    this._skillMap.clear();
    this._toolMap.clear();
    this._definitions = [];
    this.loaded = false;
  }

  async load() {
    const result = await this.loadManifest({
      skillsDir: this.skillsDir,
      publicKeyPem: this.publicKeyPem,
    });

    if (!result.ok) {
      this._clear();
      return result;
    }

    const skills = Array.isArray(result.skills) ? result.skills : [];
    const skillMap = new Map(skills.map(skill => [skill.id, skill]));
    const collision = this.nativeTools.find(tool => skillMap.has(tool.id));
    if (collision) {
      this._clear();
      return { ok: false, error: `Native tool id collides with a signed skill: ${collision.id}` };
    }

    this._skills = skills;
    this._skillMap = skillMap;
    this._toolMap = new Map([
      ...this.nativeTools.map(tool => [tool.id, tool]),
      ...skillMap,
    ]);
    this._definitions = this.promptBuilder.buildToolDefinitions([
      ...this.nativeTools,
      ...this._skills,
    ]);
    this.loaded = true;
    return result;
  }

  listSkills() {
    return this._skills.slice();
  }

  listTools() {
    return [...this.nativeTools, ...this._skills];
  }

  getSkill(skillId) {
    return this._toolMap.get(skillId) || null;
  }

  listDefinitions() {
    return this._definitions.slice();
  }

  validateCall(toolCall) {
    if (!toolCall || typeof toolCall !== 'object' || typeof toolCall.tool !== 'string' || !toolCall.tool.trim()) {
      return { ok: false, error: 'Invalid tool call' };
    }
    const tool = this.getSkill(toolCall.tool);
    if (!tool) return { ok: false, error: `Unknown tool: ${toolCall.tool}` };

    const args = toolCall.args === undefined || toolCall.args === null ? {} : toolCall.args;
    if (typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: 'Tool arguments must be an object', tool };
    }
    const argError = validateArgs(tool, args);
    if (argError) return { ok: false, error: argError, tool };
    return { ok: true, tool };
  }

  async execute(toolCall, { taskId = null, signal = null, context = null } = {}) {
    if (!toolCall || typeof toolCall !== 'object' || typeof toolCall.tool !== 'string') {
      return { ok: false, error: 'Invalid tool call' };
    }

    const tool = this.getSkill(toolCall.tool);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${toolCall.tool}` };
    }

    const args = toolCall.args || {};
    const argError = validateArgs(tool, args);
    if (argError) {
      return { ok: false, error: argError, skill: tool.id };
    }

    if (tool.source === 'native') {
      try {
        const result = await tool.execute(args, { taskId, signal, context });
        if (result && typeof result === 'object') return result;
        return { ok: true, result: String(result ?? '') };
      } catch (error) {
        return { ok: false, error: error.message, skill: tool.id };
      }
    }

    const executeOptions = {
      skill: tool,
      args,
      skillsDir: this.skillsDir,
      signal,
      timeoutMs: this.timeoutMs,
    };
    if (this.spawnImpl) executeOptions.spawnImpl = this.spawnImpl;

    return this.executeImpl(executeOptions);
  }
}

module.exports = { ToolRegistry, normalizeNativeTool };
