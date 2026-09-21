const { exec } = require('child_process');

function execute(args) {
    return new Promise((resolve) => {
        const targetProcess = args.processName || '';
        
        let psCommand = `
            $ErrorActionPreference = 'SilentlyContinue'
            $processes = Get-Process
            if ("${targetProcess}" -ne "") {
                $processes = $processes | Where-Object { $_.Name -like "*${targetProcess}*" }
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

        // Base64 encode for PowerShell -EncodedCommand (requires UTF-16LE encoding)
        const buffer = Buffer.from(psCommand, 'utf16le');
        const base64Command = buffer.toString('base64');

        exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64Command}`, 
        { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
            if (error) {
                return resolve({ ok: false, error: error.message || stderr });
            }
            try {
                const parsed = JSON.parse(stdout || '[]');
                resolve({ ok: true, data: parsed });
            } catch (e) {
                resolve({ ok: false, error: 'Failed to parse PowerShell JSON: ' + e.message, raw: stdout });
            }
        });
    });
}

module.exports = { execute };
