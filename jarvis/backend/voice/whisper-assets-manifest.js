'use strict';

/**
 * Pinned native Whisper runtime shipped with JARVIS.
 *
 * Source: whisper.cpp 1.9.5, build b5454 (whisper-bin-x64.zip)
 * https://github.com/ggml-org/whisper.cpp/releases/tag/b5454
 * Release archive SHA-256:
 * 6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb
 *
 * Model: ggml-base.en-q5_1.bin from OpenAI Whisper (MIT weights), distributed
 * by ggml-org at https://huggingface.co/ggerganov/whisper.cpp
 *
 * The Visual C++ runtime DLLs are Microsoft redistributable files required by
 * the upstream whisper.cpp build. Keeping them beside whisper-cli.exe means a
 * clean Windows install does not need Python or a separate VC++ installation.
 *
 * These hashes cover the exact bytes we ship. Code signing must not rewrite the
 * bundled sidecar after packaging; package.json excludes whisper-cli.exe from
 * electron-builder's signExts list for that reason.
 */
const WHISPER_ASSET_MANIFEST = Object.freeze({
  version: 'whisper.cpp 1.9.5 (b5454)',
  root: 'bin/whisper',
  files: Object.freeze([
    Object.freeze({
      role: 'executable',
      relativePath: 'bin/whisper/whisper-cli.exe',
      bytes: 479744,
      sha256: '331dba46d6427105d2b802cdbc7eae916ea1c5abf9b0d3b5cfe460d8db8e4366',
    }),
    Object.freeze({
      role: 'whisper_runtime',
      relativePath: 'bin/whisper/whisper.dll',
      bytes: 1370112,
      sha256: '034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674',
    }),
    Object.freeze({
      role: 'ggml',
      relativePath: 'bin/whisper/ggml.dll',
      bytes: 62464,
      sha256: '31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e',
    }),
    Object.freeze({
      role: 'ggml_base',
      relativePath: 'bin/whisper/ggml-base.dll',
      bytes: 693248,
      sha256: 'bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0',
    }),
    Object.freeze({
      role: 'cpu_alderlake',
      relativePath: 'bin/whisper/ggml-cpu-alderlake.dll',
      bytes: 1009664,
      sha256: 'd8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603',
    }),
    Object.freeze({
      role: 'cpu_cannonlake',
      relativePath: 'bin/whisper/ggml-cpu-cannonlake.dll',
      bytes: 1049600,
      sha256: '74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507',
    }),
    Object.freeze({
      role: 'cpu_cascadelake',
      relativePath: 'bin/whisper/ggml-cpu-cascadelake.dll',
      bytes: 1061376,
      sha256: '4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e',
    }),
    Object.freeze({
      role: 'cpu_haswell',
      relativePath: 'bin/whisper/ggml-cpu-haswell.dll',
      bytes: 1010688,
      sha256: '1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b',
    }),
    Object.freeze({
      role: 'cpu_icelake',
      relativePath: 'bin/whisper/ggml-cpu-icelake.dll',
      bytes: 1061376,
      sha256: '2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40',
    }),
    Object.freeze({
      role: 'cpu_sandybridge',
      relativePath: 'bin/whisper/ggml-cpu-sandybridge.dll',
      bytes: 1026560,
      sha256: '04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e',
    }),
    Object.freeze({
      role: 'cpu_skylakex',
      relativePath: 'bin/whisper/ggml-cpu-skylakex.dll',
      bytes: 1049600,
      sha256: '1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be',
    }),
    Object.freeze({
      role: 'cpu_sse42',
      relativePath: 'bin/whisper/ggml-cpu-sse42.dll',
      bytes: 862720,
      sha256: 'f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a',
    }),
    Object.freeze({
      role: 'cpu_x64',
      relativePath: 'bin/whisper/ggml-cpu-x64.dll',
      bytes: 866816,
      sha256: '4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3',
    }),
    Object.freeze({
      role: 'vc_runtime',
      relativePath: 'bin/whisper/vcruntime140.dll',
      bytes: 123472,
      sha256: '184146852727a9db4eea06178716bec3cdbb1015c911f6b0f915b184ad7775b2',
    }),
    Object.freeze({
      role: 'vc_runtime_1',
      relativePath: 'bin/whisper/vcruntime140_1.dll',
      bytes: 47264,
      sha256: 'e6bfb3662ab4b1969a73441dbe35c96d51441b6bff8cf1fe7430bd5b246ca605',
    }),
    Object.freeze({
      role: 'vc_std',
      relativePath: 'bin/whisper/msvcp140.dll',
      bytes: 553552,
      sha256: 'def46aa6a8f72f27bafac0c43334419486a4d1dcdb6c479a8ef7034b3e1fa4cb',
    }),
    Object.freeze({
      role: 'vc_openmp',
      relativePath: 'bin/whisper/vcomp140.dll',
      bytes: 213064,
      sha256: '31af29c03643f8396a6f26bcd601c6369d26493d7d78b714827ab2801bd284c7',
    }),
    Object.freeze({
      role: 'model',
      relativePath: 'bin/whisper/models/ggml-base.en-q5_1.bin',
      bytes: 59721011,
      sha256: '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f',
    }),
  ]),
});

module.exports = { WHISPER_ASSET_MANIFEST };
