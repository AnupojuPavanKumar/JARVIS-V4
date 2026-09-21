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
  if (/^\s*format\s+[a-z]:/i.test(cLower)) return 'blocked';

  const blockedPatterns = [
    /\bdiskpart\b/i,
    /\b(?:del|rd|rmdir)\s+\/s\b/i,
    /\breg\s+(?:delete|add)\b/i,
    /\bbcdedit\b/i,
    /\bnet\s+user\b/i,
    /\bshutdown\b/i,
    /\bcertutil\s+-urlcache\b/i,
    /\btakeown\b/i,
    /\bicacls\b/i,
    /\bschtasks\b/i,
    /\bwmic\b/i,
    /\bmshta\b/i,
    /\brundll32\b/i,
    /\bregsvr32\b/i,
    /\bbitsadmin\b/i,
    /\bvssadmin\b/i,
    /\bwevtutil\s+cl\b/i,
    /\bcipher\s+\/w\b/i,
    /\bnetsh\s+advfirewall\b/i,
    /\bnet\s+localgroup\b/i,
    /\bsc\s+(?:create|config)\b/i,
    /\bstart-process\b/i,
    /\binvoke-webrequest\b/i
  ];
  for (const p of blockedPatterns) {
    if (p.test(cLower)) return 'blocked';
  }

  if (/\b(?:curl|wget)\b/i.test(cLower)) {
    if (/(?:-o|-O|--output)\b/i.test(c)) return 'blocked';
    if (/\|\s*(?:bash|sh|cmd|powershell|pwsh)\b/i.test(cLower)) return 'blocked';
  }

  if (/\b(?:del|erase)\b/i.test(cLower)) {
    if (/[*?]/.test(c) || /\/q\b/i.test(cLower) || /\/f\b/i.test(cLower)) return 'blocked';
  }

  if (/\btaskkill\b/i.test(cLower) && /\/f\b/i.test(cLower)) {
    if (/csrss|winlogon|lsass|smss|wininit|services|svchost|system|registry|dwm|explorer|audiodg|winrt\.exe/i.test(cLower)) {
      return 'blocked';
    }
  }

  if (/\b(?:powershell|pwsh)\b/i.test(cLower)) {
    if (/\s-e[a-z]*\b/i.test(cLower)) return 'blocked';
    return 'confirm';
  }
  if (/\bcmd\s+\/c\b/i.test(cLower)) return 'confirm';

  const readOnlyPattern = /^\s*(whoami|hostname|ver|dir|ipconfig|systeminfo|tasklist|where|node\s+-v|python\s+--version)(\s+.*)?$/i;
  if (readOnlyPattern.test(c)) return 'safe';
  
  if (/^git\s+(status|log|branch|diff|show|rev-parse|remote)(\s|$)/i.test(c)) {
    if (/^[A-Za-z0-9._\/=:@~^ %-]+$/.test(c)) {
      if (!/(?:^|\s)(-c|--output|--exec-path|--upload-pack|--receive-pack|--ext-diff|--textconv|--open-files-in-pager)\b/.test(c)) {
        return 'safe';
      }
    }
  }

  return 'confirm';
}

module.exports = { classifyCommand, INTERNAL_ALLOWLIST };
