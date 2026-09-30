const INTERNAL_ALLOWLIST = new Set([
  'tasklist /FO CSV /NH',
  'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name --format=csv,noheader,nounits'
]);

function classifyCommand(cmdStr) {
  if (typeof cmdStr !== 'string') return 'blocked';
  const c = cmdStr.trim();
  if (INTERNAL_ALLOWLIST.has(c)) return 'safe';

  // Normalise Unicode full-width / homoglyph characters that could spoof ASCII
  // e.g. ｔａｓｋｋｉｌｌ → taskkill
  const normalized = c.normalize('NFKC');

  // Check for chaining/redirection characters (applies to normalised form too)
  if (/[&|;`><]/.test(normalized)) return 'blocked';

  const cLower = c.toLowerCase();
  if (/^\s*format\s+[a-z]:/i.test(cLower)) return 'blocked';

  // Run all pattern checks against the Unicode-normalised lowercase form
  const cNormLower = normalized.toLowerCase();

  // Strip any leading full path so "C:\Windows\System32\wscript.exe" → "wscript.exe"
  // This prevents path-prefix bypass.
  const baseToken = cNormLower.replace(/^[a-z]:[\\/.]+/, '').replace(/^.*[\\/]/, '');

  const blockedPatterns = [
    /\bdiskpart\b/i,
    /\b(?:del|rd|rmdir)\s+\/s\b/i,
    /\breg\s+(?:delete|add)\b/i,
    /\bbcdedit\b/i,
    /\bnet\s+user\b/i,
    /\bshutdown\b/i,
    /\bcertutil\b/i,                  // any certutil usage
    /\btakeown\b/i,
    /\bicacls\b/i,
    /\bschtasks\b/i,
    /\bwmic\b/i,
    /\bmshta\b/i,
    /\brundll32\b/i,
    /\bregsvr32\b/i,
    /\bbitsadmin\b/i,
    /\bvssadmin\b/i,
    /\bwevtutil\b/i,
    /\bcipher\s+\/w\b/i,
    /\bnetsh\s+advfirewall\b/i,
    /\bnet\s+localgroup\b/i,
    /\bsc\s+(?:create|config|stop|delete)\b/i,
    /\bstart-process\b/i,
    /\binvoke-webrequest\b/i,
    /\binvoke-expression\b/i,         // IEX — common PowerShell download-exec
    /\biex\b/i,
    /\bcscript\b/i,                   // Windows Script Host
    /\bwscript\b/i,
    /\bat\.exe\b/i,                   // legacy task scheduler
    /\bexpand\b/i,                    // cabinet expander LOLbin
    /\bextrac32\b/i,
    /\bpcalua\b/i,
    /\bmsiexec\b/i,                   // installer abuse
    /\bappinstaller\b/i,
    /\bforfiles\b/i,
    /\beventcreate\b/i,
  ];
  for (const p of blockedPatterns) {
    if (p.test(cNormLower) || p.test(baseToken)) return 'blocked';
  }

  if (/\b(?:curl|wget)\b/i.test(cNormLower)) {
    if (/(?:-o|-O|--output)\b/i.test(normalized)) return 'blocked';
    if (/\|\s*(?:bash|sh|cmd|powershell|pwsh)\b/i.test(cNormLower)) return 'blocked';
  }

  if (/\b(?:del|erase)\b/i.test(cNormLower)) {
    if (/[*?]/.test(normalized) || /\/q\b/i.test(cNormLower) || /\/f\b/i.test(cNormLower)) return 'blocked';
  }

  if (/\btaskkill\b/i.test(cNormLower) && /\/f\b/i.test(cNormLower)) {
    if (/csrss|winlogon|lsass|smss|wininit|services|svchost|system|registry|dwm|explorer|audiodg|winrt\.exe/i.test(cNormLower)) {
      return 'blocked';
    }
  }

  if (/\b(?:powershell|pwsh)\b/i.test(cNormLower)) {
    // Block encoded commands, download-exec patterns, and bypass flags
    if (/\\s-e(?:n(?:c(?:o(?:d(?:e(?:d)?)?)?)?)?)?\\b/i.test(cNormLower) || /\\s-ec\\b/i.test(cNormLower)) return 'blocked';  // -EncodedCommand
    if (/\s-nop(?:r(?:o(?:f(?:i(?:l(?:e)?)?)?)?)?)?\b/i.test(cNormLower)) return 'blocked'; // -NoProfile
    if (/\s-w(?:i(?:n(?:d(?:o(?:w(?:s(?:t(?:y(?:l(?:e)?)?)?)?)?)?)?)?)?)?\s+h/i.test(cNormLower)) return 'blocked'; // -WindowStyle Hidden
    return 'confirm';
  }
  if (/\bcmd\s+\/c\b/i.test(cNormLower)) return 'confirm';

  const readOnlyPattern = /^\s*(whoami|hostname|ver|dir|ipconfig|systeminfo|tasklist|where|node\s+-v|python\s+--version)(\s+.*)?$/i;
  if (readOnlyPattern.test(normalized)) return 'safe';

  if (/^git\s+(status|log|branch|diff|show|rev-parse|remote)(\s|$)/i.test(normalized)) {
    if (/^[A-Za-z0-9._\/=:@~^ %-]+$/.test(normalized)) {
      if (!/(?:^|\s)(-c|--output|--exec-path|--upload-pack|--receive-pack|--ext-diff|--textconv|--open-files-in-pager)\b/.test(normalized)) {
        return 'safe';
      }
    }
  }

  return 'confirm';
}

module.exports = { classifyCommand, INTERNAL_ALLOWLIST };
