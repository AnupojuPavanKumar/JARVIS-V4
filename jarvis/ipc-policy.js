const INTERNAL_ALLOWLIST = new Set([
  'tasklist /FO CSV /NH',
  'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name --format=csv,noheader,nounits'
]);

function classifyCommand(cmdStr) {
  if (typeof cmdStr !== 'string') return 'blocked';
  const c = cmdStr.trim();
  if (INTERNAL_ALLOWLIST.has(c)) return 'safe';

  // Check for chaining/redirection characters
  if (/[&|;`><]/.test(c)) return 'blocked';

  const cLower = c.toLowerCase();
  
  const blockedPatterns = [
    /\bformat\b/i,
    /\bdiskpart\b/i,
    /\b(?:del|rd|rmdir)\s+\/s\b/i,
    /\breg\s+(?:delete|add)\b/i,
    /\bbcdedit\b/i,
    /\bnet\s+user\b/i,
    /\bshutdown\b/i,
    /\bcertutil\s+-urlcache\b/i
  ];
  
  for (const p of blockedPatterns) {
    if (p.test(cLower)) return 'blocked';
  }

  if (/\btaskkill\b/i.test(cLower) && /\/f\b/i.test(cLower)) {
    if (/csrss|winlogon|lsass|smss|wininit|services|svchost|system|registry|dwm|explorer|audiodg|winrt\.exe/i.test(cLower)) {
      return 'blocked';
    }
  }

  if (/\b(?:powershell|pwsh)\b/i.test(cLower)) {
    if (/(?:-enc|-encodedcommand|-e|iex|invoke-expression|downloadstring)\b/i.test(cLower)) return 'blocked';
  }

  if (/\b(?:curl|wget)\b/i.test(cLower) && /\|\s*(?:bash|sh|cmd|powershell|pwsh)\b/i.test(cLower)) {
    return 'blocked';
  }

  return 'safe';
}

module.exports = { classifyCommand, INTERNAL_ALLOWLIST };
