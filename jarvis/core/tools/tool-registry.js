'use strict';

const { validateArgs } = require('../../agent-policy');
const { loadVerifiedSkillsManifest, SKILLS_PUBLIC_KEY_PEM } = require('../skills/manifest');
const { executeSkill } = require('../skills/executor');
const { PromptBuilder } = require('../context/prompt-builder');

// Verified skill catalog plus execution. The runtime treats this as its tool
// boundary; policy authorization happens before execute() is called.
class ToolRegistry {
  constructor({
    skillsDir,
    publicKeyPem = SKILLS_PUBLIC_KEY_PEM,
    loadManifest = loadVerifiedSkillsManifest,
    execute = executeSkill,
    promptBuilder = new PromptBuilder(),
    spawnImpl = undefined,
    timeoutMs = 10000,
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

    this.skillsDir = skillsDir;
    this.publicKeyPem = publicKeyPem;
    this.loadManifest = loadManifest;
    this.executeImpl = execute;
    this.promptBuilder = promptBuilder;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;

    this._skills = [];
    this._skillMap = new Map();
    this._definitions = [];
    this.loaded = false;
  }

  async load() {
    const result = await this.loadManifest({
      skillsDir: this.skillsDir,
      publicKeyPem: this.publicKeyPem,
    });

    if (!result.ok) {
      this._skills = [];
      this._skillMap.clear();
      this._definitions = [];
      this.loaded = false;
      return result;
    }

    this._skills = Array.isArray(result.skills) ? result.skills : [];
    this._skillMap = new Map(this._skills.map(skill => [skill.id, skill]));
    this._definitions = this.promptBuilder.buildToolDefinitions(this._skills);
    this.loaded = true;
    return result;
  }

  listSkills() {
    return this._skills.slice();
  }

  getSkill(skillId) {
    return this._skillMap.get(skillId) || null;
  }

  listDefinitions() {
    return this._definitions.slice();
  }

  async execute(toolCall, { signal = null } = {}) {
    if (!toolCall || typeof toolCall !== 'object' || typeof toolCall.tool !== 'string') {
      return { ok: false, error: 'Invalid tool call' };
    }

    const skill = this.getSkill(toolCall.tool);
    if (!skill) {
      return { ok: false, error: `Unknown tool: ${toolCall.tool}` };
    }

    const args = toolCall.args || {};
    const argError = validateArgs(skill, args);
    if (argError) {
      return { ok: false, error: argError, skill: skill.id };
    }

    const executeOptions = {
      skill,
      args,
      skillsDir: this.skillsDir,
      signal,
      timeoutMs: this.timeoutMs,
    };
    if (this.spawnImpl) executeOptions.spawnImpl = this.spawnImpl;

    return this.executeImpl(executeOptions);
  }
}

module.exports = { ToolRegistry };
