'use strict';

const {
  normalizeText,
  inferType,
  classifySensitivity,
} = require('./memory-schema');

// Deterministic, model-free extraction. It is deliberately conservative: a
// conversational aside is not a memory unless the user used an explicit
// remembering cue or a small set of stable self-description patterns.
const MAX_CANDIDATES = 20;

const PATTERNS = [
  {
    re: /\b(?:please\s+)?remember\s+(?:that|this|the following)?\s*[:,-]?\s*(.+)$/i,
    type: 'fact',
    build: match => match[1],
    confidence: 0.95,
  },
  {
    re: /\b(?:note|keep in mind)\s+(?:that|this)?\s*[:,-]?\s*(.+)$/i,
    type: 'fact',
    build: match => match[1],
    confidence: 0.9,
  },
  {
    re: /\bmy\s+name\s+is\s+([^.!?]+)/i,
    type: 'fact',
    build: match => `User's name is ${match[1].trim()}.`,
    confidence: 0.95,
  },
  {
    re: /\b(?:call me|i'?m called)\s+([^.!?]+)/i,
    type: 'fact',
    build: match => `User prefers to be called ${match[1].trim()}.`,
    confidence: 0.9,
  },
  {
    re: /\bmy\s+favou?rite\s+([^.!?]+?)\s+is\s+([^.!?]+)/i,
    type: 'preference',
    build: match => `User's favorite ${match[1].trim()} is ${match[2].trim()}.`,
    confidence: 0.9,
  },
  {
    re: /\bi\s+(prefer|like|love|enjoy|hate|dislike)\s+([^.!?]+)/i,
    type: 'preference',
    build: match => `User ${match[1].toLowerCase()}s ${match[2].trim()}.`,
    confidence: 0.85,
  },
  {
    re: /\bi\s+(?:always|usually|normally)\s+([^.!?]+)/i,
    type: 'preference',
    build: match => `User usually ${match[1].trim()}.`,
    confidence: 0.7,
  },
  {
    re: /\bi\s+work\s+(?:at|for)\s+([^.!?]+)/i,
    type: 'fact',
    build: match => `User works at ${match[1].trim()}.`,
    confidence: 0.85,
  },
  {
    re: /\bi\s+(?:live|am based)\s+in\s+([^.!?]+)/i,
    type: 'fact',
    build: match => `User lives in ${match[1].trim()}.`,
    confidence: 0.85,
  },
  {
    re: /\bi\s+am\s+from\s+([^.!?]+)/i,
    type: 'fact',
    build: match => `User is from ${match[1].trim()}.`,
    confidence: 0.8,
  },
  {
    re: /\bmy\s+birthday\s+is\s+([^.!?]+)/i,
    type: 'fact',
    build: match => `User's birthday is ${match[1].trim()}.`,
    confidence: 0.9,
  },
  {
    re: /\bi\s+(?:use|run)\s+([^.!?]+)/i,
    type: 'preference',
    build: match => `User uses ${match[1].trim()}.`,
    confidence: 0.65,
  },
];

function splitUtterances(text) {
  return String(text || '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map(part => part.trim())
    .filter(part => part.length >= 4 && part.length <= 2000);
}

function extractCandidates(text, { source = { kind: 'conversation' } } = {}) {
  const candidates = [];
  const seen = new Set();

  for (const utterance of splitUtterances(text)) {
    for (const pattern of PATTERNS) {
      const match = utterance.match(pattern.re);
      if (!match) continue;
      const value = normalizeText(pattern.build(match));
      if (!value || value.length < 4) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        type: pattern.type,
        text: value,
        source,
        confidence: pattern.confidence,
        sensitivity: classifySensitivity(value),
        inferredType: inferType(value),
      });
      if (candidates.length >= MAX_CANDIDATES) return candidates;
      break;
    }
  }

  return candidates;
}

function extractConversationCandidates(messages, { sessionId = null, sourceKind = 'conversation' } = {}) {
  const candidates = [];
  const seen = new Set();
  if (!Array.isArray(messages)) return candidates;

  for (const message of messages) {
    if (!message || message.role !== 'user' || typeof message.content !== 'string') continue;
    const source = {
      kind: sourceKind,
      ...(sessionId ? { sessionId: String(sessionId).slice(0, 160) } : {}),
    };
    for (const candidate of extractCandidates(message.content, { source })) {
      const key = candidate.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
  }

  return candidates;
}

function summarizeConversation(messages, { maxChars = 1400 } = {}) {
  if (!Array.isArray(messages)) return '';
  const relevant = messages
    .filter(message => message && ['user', 'assistant'].includes(message.role))
    .slice(-8)
    .map(message => {
      const role = message.role === 'user' ? 'User' : 'JARVIS';
      const content = normalizeText(message.content).slice(0, 500);
      return content ? `${role}: ${content}` : '';
    })
    .filter(Boolean);

  const summary = relevant.join('\n');
  if (!summary) return '';
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary;
}

module.exports = {
  MAX_CANDIDATES,
  extractCandidates,
  extractConversationCandidates,
  summarizeConversation,
};
