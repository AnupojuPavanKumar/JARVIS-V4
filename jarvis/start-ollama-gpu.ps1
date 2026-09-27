# JARVIS - Start Ollama with NVIDIA RTX 4050 CUDA acceleration
# Run this script whenever Ollama needs to be (re)started with GPU support

Write-Host "=== JARVIS - Ollama GPU Launcher ===" -ForegroundColor Cyan
Write-Host "GPU: NVIDIA GeForce RTX 4050 (6GB VRAM)" -ForegroundColor Cyan
Write-Host ""

# Kill any existing Ollama process
$existing = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing Ollama process..." -ForegroundColor Yellow
    Stop-Process -Name "ollama" -Force
    Start-Sleep -Seconds 2
}

# Set environment variables for GPU usage
$env:CUDA_VISIBLE_DEVICES = "0"          # Use GPU 0 (RTX 4050)
$env:OLLAMA_NUM_GPU       = "99"         # Offload all layers to GPU
$env:OLLAMA_GPU_LAYERS    = "99"         # Alias for compatibility
$env:OLLAMA_FLASH_ATTENTION = "1"        # Enable Flash Attention (faster on CUDA)

# Workarounds for VRAM limits and context size on 6GB VRAM
$env:OLLAMA_MAX_VRAM = "5368709120"      # Limit to 5GB (leave 1GB for OS/Display)
$env:OLLAMA_KV_CACHE_TYPE = "q8_0"       # Quantize KV cache to save VRAM

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
    Write-Host "Testing GPU inference..." -ForegroundColor Yellow
    ollama run llama3.1:8b "reply only: CUDA OK" 2>&1
    Write-Host ""
    ollama ps
} else {
    Write-Host "ERROR: Ollama failed to start!" -ForegroundColor Red
}
