# Third-party notices

Hlið itself is licensed under the MIT License. Packaged Windows builds include
the reviewed speech-to-text runtime below. The optional local neural read-aloud
feature downloads its runtime and model files only after the user chooses
Download in Forge; those files are not embedded in the Hlið executable or source
distribution.

## whisper.cpp v1.9.1 runtime

- Purpose: local speech-to-text with portable CPU and Vulkan backends
- Project: `ggml-org/whisper.cpp`
- Source revision: `f049fff95a089aa9969deb009cdd4892b3e74916`
- Source:
  `https://github.com/ggml-org/whisper.cpp/tree/f049fff95a089aa9969deb009cdd4892b3e74916`
- License: MIT
- Copyright: Copyright (c) 2023-2026 The ggml authors
- Runtime archive: `hlid-whisper-runtime-windows-x64-v1.9.1.zip`
- Runtime archive SHA-256:
  `238d0f7cd98fac00b2e0e117668c28b0105d3dd863aeadedf1973a5a709ab10a`
- Build provenance: Hlid's release workflow checks out the exact source
  revision, builds `whisper-server` and the reviewed shared libraries on
  Windows x64, audits the runtime manifest, and embeds the verified archive in
  the packaged executable.

The runtime contains `whisper-server.exe`, `whisper.dll`, the reviewed GGML CPU
and Vulkan libraries, and the pinned upstream `LICENSE`. The same license file
is embedded with the runtime in the packaged Hlid executable and materialized
beside the runtime files. Whisper model files remain separate downloads managed
from Forge.

## Kitten Nano v0.8 Int8

- Purpose: English text-to-speech model with eight included voices
- Model project: `KittenML/KittenTTS`
- Model archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_8-int8.tar.bz2`
- Archive SHA-256:
  `6fa5be852612ce761094ba74ee6123b4fc4acfefa79bf64dc63acae4a83af2fd`
- License: Apache License 2.0
- License copy: the downloaded archive includes `LICENSE`
- Source: `https://github.com/KittenML/KittenTTS`

## Piper voice models

Hlið offers three curated English Piper voice archives from the sherpa-onnx
TTS model release. Each archive includes a `MODEL_CARD` identifying its
source voice and training data.

Kristin, US English feminine:

- Archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-kristin-medium-int8.tar.bz2`
- Archive SHA-256:
  `16289d7ee8e6b2311a0a0af6531a55f498f82499644a1bb6fddb991fe6fa950c`

Bryce, US English masculine:

- Archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-bryce-medium-int8.tar.bz2`
- Archive SHA-256:
  `89cd4f464c91579440565927bfca9d26555f577c4e37431167568c934fdb82f6`

Cori, UK English feminine:

- Archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-cori-medium-int8.tar.bz2`
- Archive SHA-256:
  `169ca8aff3adb271f009a4924c99928a811dbf2b52eaca2dbb460e8c34478c93`

For these three voice packs:

- Purpose: English text-to-speech
- Model repository and license declaration:
  `https://huggingface.co/rhasspy/piper-voices`
- Model license: MIT
- Training data declaration: public domain, as recorded in each downloaded
  archive's `MODEL_CARD`
- Piper source: `https://github.com/rhasspy/piper`

## sherpa-onnx 1.13.4 runtime

- Purpose: ONNX inference and speech synthesis runtime
- Project: `k2-fsa/sherpa-onnx`
- License declared by the runtime packages: Apache License 2.0
- Source: `https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.4`

Windows x64 package:

- Archive:
  `https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-1.13.4.tgz`
- Archive SHA-256:
  `c180199ee4ed16a25b8ed50e2706a2d3dbe1aaa8b0699ea7d249288290c7998e`

Linux x64 package, used for development and validation:

- Archive:
  `https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.4.tgz`
- Archive SHA-256:
  `a139f26eb19c30af9ef29a5390bd5f31baed8d93b20ee5eb63c6c4f339bbb059`

## eSpeak-ng

sherpa-onnx builds text-to-phoneme support for these models with eSpeak-ng.
Each downloaded model archive includes the required eSpeak-ng language data.

- Purpose: text-to-phoneme conversion
- License: GNU General Public License version 3 or later
- Upstream source and license: `https://github.com/espeak-ng/espeak-ng`
- Source revision referenced by sherpa-onnx 1.13.4:
  `https://github.com/csukuangfj/espeak-ng/tree/ed530aa113046142eb5115cf2fc9157854d0ffe1`
- sherpa-onnx build definition:
  `https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.4/cmake/espeak-ng-for-piper.cmake`

The optional runtime and model remain in Hlið's application data directory.
Deleting the model in Forge removes the model files. The shared runtime stays
available for a later reinstall.
