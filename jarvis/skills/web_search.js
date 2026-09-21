// JARVIS Skill: Web Search (delegates to main process via IPC - this is a stub)
// The actual web search is handled by the main process IPC handler
const args = JSON.parse(process.argv[2] || '{"query":""}');
console.log(JSON.stringify({
  ok: true,
  skill: 'web_search',
  data: { query: args.query, delegated: true, message: 'Web search delegated to main process' }
}));
