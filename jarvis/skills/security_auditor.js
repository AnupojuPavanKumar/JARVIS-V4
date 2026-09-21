const { spawn } = require('child_process');
const args = JSON.parse(process.argv[2] || '{}');
const targetProcess = args.processName || '';

if (targetProcess && !/^[A-Za-z0-9_.-]{1,64}$/.test(targetProcess)) {
    console.log(JSON.stringify({ ok: false, error: 'Invalid processName format.' }));
    process.exit(0);
}

let psCommand = `
$ErrorActionPreference = 'SilentlyContinue'
$processes = Get-Process
$target = $env:JV_PROC
if ($target -ne "") {
    $processes = $processes | Where-Object { $_.Name -like "*$target*" }
}

$processes = $processes | Where-Object { $_.Path -ne $null } | Sort-Object WS -Descending | Select-Object -First 15

$results = @()
foreach ($p in $processes) {
    $sig = Get-AuthenticodeSignature $p.Path
    $status = if ($sig) { $sig.Status.ToString() } else { "Unknown" }
    $signer = if ($sig -and $sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "Unsigned" }
    
    $results += [PSCustomObject]@{
        ProcessName = $p.Name
        Id = $p.Id
        Path = $p.Path
        SignatureStatus = $status
        Signer = $signer
    }
}

$results | ConvertTo-Json -Compress
`;

const buffer = Buffer.from(psCommand, 'utf16le');
const base64Command = buffer.toString('base64');

const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', base64Command], {
    shell: false,
    env: Object.assign({}, process.env, { JV_PROC: targetProcess })
});

let stdout = '';
let stderr = '';

child.stdout.on('data', data => stdout += data);
child.stderr.on('data', data => stderr += data);

child.on('close', code => {
    if (code !== 0 && stderr) {
        console.log(JSON.stringify({ ok: false, error: stderr.trim() }));
        process.exit(0);
    }
    try {
        const parsed = JSON.parse(stdout || '[]');
        console.log(JSON.stringify({ ok: true, data: parsed }));
    } catch (e) {
        console.log(JSON.stringify({ ok: false, error: 'Failed to parse PowerShell JSON: ' + e.message, raw: stdout }));
    }
});
