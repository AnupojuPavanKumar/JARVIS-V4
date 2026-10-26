# JARVIS - Start Ollama with NVIDIA RTX 4050 CUDA acceleration
# Run this script whenever Ollama needs to be (re)started with GPU support

Write-Host "=== JARVIS - Ollama GPU Launcher ===" -ForegroundColor Cyan
Write-Host "GPU: NVIDIA GeForce RTX 4050 (6GB VRAM)" -ForegroundColor Cyan
Write-Host ""

# Kill any existing Ollama and llama-server processes
$existing = Get-Process -Name "ollama", "llama-server" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing Ollama and llama-server processes..." -ForegroundColor Yellow
    Stop-Process -Name "ollama", "llama-server" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# Set environment variables for GPU usage
# Note: GPU layer offload is decided per-request via the "num_gpu" option (or
# Ollama's automatic fit). OLLAMA_NUM_GPU / OLLAMA_GPU_LAYERS / OLLAMA_MAX_VRAM
# are not real Ollama settings and have been removed.
$env:CUDA_VISIBLE_DEVICES = "0"          # Use GPU 0 (RTX 4050)
$env:OLLAMA_FLASH_ATTENTION = "1"        # Enable Flash Attention (faster on CUDA)
$env:OLLAMA_KV_CACHE_TYPE = "q8_0"       # Quantize KV cache to save VRAM

# Load the chat model during startup instead of waiting for the first chat
# request. The probe used to set keep_alive = 0, which immediately unloaded the
# model again and made every first message pay the cold-load cost. Keep the
# model resident for the configured window; set JARVIS_MODEL_KEEP_ALIVE=0 to
# restore the old unload-after-probe behavior.
$preloadModel = if ($env:JARVIS_PRELOAD_MODEL) { $env:JARVIS_PRELOAD_MODEL } else { "llama3.1:8b" }
$keepAlive = if ($env:JARVIS_MODEL_KEEP_ALIVE) { $env:JARVIS_MODEL_KEEP_ALIVE } else { "10m" }

Write-Host "Environment configured for CUDA on RTX 4050." -ForegroundColor Green

# Start Ollama Serve silently in the background
Write-Host "Starting Ollama with CUDA acceleration..." -ForegroundColor Cyan
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden

Start-Sleep -Seconds 3

# Verify it started
$proc = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "Ollama started (PID: $($proc.Id))" -ForegroundColor Green
    Write-Host ""
    Write-Host "Preloading $preloadModel and testing GPU inference..." -ForegroundColor Yellow
    try {
        $probe = @{
            model = $preloadModel
            prompt = "reply only: CUDA OK"
            stream = $false
            keep_alive = $keepAlive
            options = @{ num_ctx = 3072; num_predict = 8; num_gpu = 99; num_thread = 8 }
        } | ConvertTo-Json -Depth 4
        Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/generate" -Method Post -Body $probe -ContentType "application/json" | Out-Null
        Write-Host "CUDA inference OK; model is warm (keep_alive=$keepAlive)." -ForegroundColor Green
    } catch {
        Write-Host "CUDA probe failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    Write-Host ""
    ollama ps
} else {
    Write-Host "ERROR: Ollama failed to start!" -ForegroundColor Red
}
