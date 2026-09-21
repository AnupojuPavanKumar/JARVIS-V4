#!/usr/bin/env python3
import sys
import os
import warnings

# Suppress annoying warnings
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

try:
    import whisper
    import torch
except ImportError:
    print("ERROR: Whisper or Torch not installed. Please run: pip install openai-whisper torch")
    sys.exit(1)

def main():
    # Load model once, keep it in memory
    print("LOADING_MODEL")
    sys.stdout.flush()
    
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = whisper.load_model("base", device=device) # base is fast and accurate enough for English commands
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
            # Transcribe
            result = model.transcribe(audio_path, fp16=True)
            text = result['text'].strip()
            
            # Print output with a specific prefix so Node can parse it easily
            print(f"TRANSCRIPTION:{text}")
            sys.stdout.flush()
        except Exception as e:
            print(f"ERROR: Transcription failed - {e}")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
