#!/usr/bin/env python3
import sys
import os
import wave
import warnings

import numpy as np

# Suppress annoying warnings
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

try:
    import whisper
    import torch
except ImportError:
    print("ERROR: Whisper or Torch not installed. Please run: pip install openai-whisper torch")
    sys.exit(1)


WHISPER_SAMPLE_RATE = 16000


def looks_like_wav(audio_path):
    try:
        with open(audio_path, 'rb') as handle:
            header = handle.read(12)
        return len(header) == 12 and header[0:4] == b'RIFF' and header[8:12] == b'WAVE'
    except OSError:
        return False


def read_wav(audio_path):
    with wave.open(audio_path, 'rb') as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        source_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())

    if sample_width != 2:
        raise ValueError("Whisper WAV input must be 16-bit PCM")
    if channels < 1:
        raise ValueError("WAV input has no channels")

    samples = np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if source_rate != WHISPER_SAMPLE_RATE and samples.size:
        length = max(1, int(round(samples.size * WHISPER_SAMPLE_RATE / source_rate)))
        old_positions = np.linspace(0.0, 1.0, samples.size, endpoint=False)
        new_positions = np.linspace(0.0, 1.0, length, endpoint=False)
        samples = np.interp(new_positions, old_positions, samples).astype(np.float32)
    return samples


def main():
    # Load model once, keep it in memory
    print("LOADING_MODEL")
    sys.stdout.flush()
    
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model_name = os.environ.get("JARVIS_WHISPER_MODEL", "base")
        model = whisper.load_model(model_name, device=device) # resident in memory for the local voice loop
        print("READY")
        sys.stdout.flush()
    except Exception as e:
        print(f"ERROR: Failed to load model - {e}")
        sys.exit(1)

    # Listen on stdin for file paths
    for line in sys.stdin:
        audio_path = line.strip()
        if not audio_path:
            continue
            
        if audio_path.upper() == 'PING':
            print('PONG')
            sys.stdout.flush()
            continue

        if audio_path.upper() == 'EXIT':
            break


        if not os.path.exists(audio_path):
            print(f"ERROR: Audio file not found at {audio_path}")
            sys.stdout.flush()
            continue

        try:
            # fp16 is only valid on CUDA. CPU uses fp32 and still stays local.
            audio_input = read_wav(audio_path) if looks_like_wav(audio_path) else audio_path
            result = model.transcribe(
                audio_input,
                fp16=(device == "cuda"),
                language=os.environ.get("JARVIS_WHISPER_LANGUAGE", "en"),
                condition_on_previous_text=False,
            )
            text = result['text'].strip()
            
            # Print output with a specific prefix so Node can parse it easily
            print(f"TRANSCRIPTION:{text}")
            sys.stdout.flush()
        except Exception as e:
            print(f"ERROR: Transcription failed - {e}")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
