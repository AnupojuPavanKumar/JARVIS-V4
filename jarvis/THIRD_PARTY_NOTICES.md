# Third-Party Notices

JARVIS bundles the following native components for local voice transcription.

## whisper.cpp and ggml

`bin/whisper/whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, and the
`ggml-cpu-*.dll` runtime files are from whisper.cpp 1.9.5, build b5454:

- https://github.com/ggml-org/whisper.cpp/releases/tag/b5454
- Release archive `whisper-bin-x64.zip` SHA-256:
  `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb`

MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### miniaudio

The whisper.cpp command-line tools link miniaudio, which is dual-licensed as
public domain (Unlicense) or MIT-0. See https://github.com/mackron/miniaudio.

## Whisper model weights

`bin/whisper/models/ggml-base.en-q5_1.bin` is a quantized conversion of the
OpenAI Whisper `base.en` model, distributed by ggml-org at
https://huggingface.co/ggerganov/whisper.cpp. Model file SHA-256:
`4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f`.

MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Microsoft Visual C++ runtime

`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`, and `vcomp140.dll` are
Microsoft Visual C++ 2015-2022 Redistributable runtime files required by the
upstream whisper.cpp binaries.

Copyright (c) Microsoft Corporation. All rights reserved.

These files are redistributed under the Microsoft Visual Studio redistributable
terms: https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
