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

Hlið offers six curated English Piper voice archives from the sherpa-onnx TTS
model release. Five are single-voice packs. LibriTTS High is a multi-speaker
model from which Hlið exposes five curated speaker IDs from the qualified
model. Each archive includes a `MODEL_CARD` identifying its source data.

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

Norman, US English masculine:

- Archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-norman-medium-int8.tar.bz2`
- Archive size: 20,987,233 bytes
- Archive SHA-256:
  `cb481a514bc213ccf3899391c0f27fdcc4e4b814ec30496f28089a027b5aa01b`
- Model card:
  `https://huggingface.co/rhasspy/piper-voices/raw/main/en/en_US/norman/medium/MODEL_CARD`
- Training data: public-domain LibriVox recordings, as recorded in the model
  card included in the downloaded archive
- License scope: Hlið relies on the Piper model repository's MIT declaration;
  the downloaded archive includes `MODEL_CARD` but no standalone model-license
  file

Cori, UK English feminine:

- Archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-cori-medium-int8.tar.bz2`
- Archive SHA-256:
  `169ca8aff3adb271f009a4924c99928a811dbf2b52eaca2dbb460e8c34478c93`

LJSpeech High, larger US English feminine:

- Archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-ljspeech-high-int8.tar.bz2`
- Archive SHA-256:
  `916b2526d4ea191f9710bd2753698ac97926ec38eade867408d3f5fd422ca285`

LibriTTS High, larger multi-speaker US English model:

- Exposed speakers: `p3922` (`sid 0`, feminine), `p6701` (`sid 3`, masculine),
  `p922` (`sid 5`, masculine), `p8152` (`sid 132`, masculine), and `p2085`
  (`sid 903`, feminine), using only the source corpus's presentation metadata
- Archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-libritts-high-int8.tar.bz2`
- Archive SHA-256:
  `c35f249498fe9406c5ca3b6db1fc16749d7ee415ff2a09d5da9334206c2e0026`
- Model card:
  `https://huggingface.co/rhasspy/piper-voices/raw/main/en/en_US/libritts/high/MODEL_CARD`
- Training data: LibriTTS `train-clean-360`, CC BY 4.0
- Corpus: `https://www.openslr.org/60/`
- Corpus paper: `https://arxiv.org/abs/1904.02882`
- License terms: `https://creativecommons.org/licenses/by/4.0/`

For these six voice packs:

- Purpose: English text-to-speech
- Piper model repository and MIT license declaration:
  `https://huggingface.co/rhasspy/piper-voices`
- The downloaded Piper archives include model cards but do not include a
  separate standalone model-license file. Hlið attributes MIT to the publisher
  repository rather than representing it as an in-archive license grant.
- Kristin, Bryce, Cori, Norman, and LJSpeech High training data: public domain,
  as recorded in each downloaded archive's `MODEL_CARD`; Norman uses LibriVox
  recordings and LJSpeech High was trained from scratch
- LibriTTS High was trained from scratch on the CC BY 4.0 LibriTTS corpus.
  LibriTTS was prepared by Heiga Zen and contributors from LibriVox recordings
  and Project Gutenberg texts. Hlið downloads the Piper archive unchanged,
  uses numeric corpus IDs rather than source-reader names as voice labels, and
  does not imply that a generated voice is the source reader or that the reader
  endorses Hlið.
- Piper source: `https://github.com/rhasspy/piper`

## MeloTTS English

- Purpose: English text-to-speech
- Exposed voices: publisher labels `EN-US` (`sid 0`), `EN-BR` (`sid 1`),
  `EN_INDIA` (`sid 2`), `EN-AU` (`sid 3`), and `EN-Default` (`sid 4`)
- Hlið presents `EN-Default` as unspecified Default English and does not infer
  an accent from that publisher label
- Model archive:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-en.tar.bz2`
- Archive size: 162,758,237 bytes
- Archive SHA-256:
  `f87bc5752ea3ec34273a2cc0c5086854c18b6b89dfd0534b5248e86a14cedb5d`
- Conversion source:
  `https://github.com/myshell-ai/MeloTTS/tree/209145371cff8fc3bd60d7be902ea69cbdb7965a`
- Publisher model repository and MIT declaration:
  `https://huggingface.co/myshell-ai/MeloTTS-English/tree/bb4fb7346d566d277ba8c8c7dbfdf6786139b8ef`
- License notice: the unchanged archive contains MyShell.ai's MIT notice,
  copyright 2024 MyShell.ai; its ONNX metadata also declares the MIT license
- Frontend: the unchanged archive's `lexicon.txt`; no eSpeak-ng data is used

The publisher does not identify the published checkpoint's training datasets,
audio provenance, source-speaker identity, or speaker consent. Hlið therefore
makes no claim about those facts and does not infer speaker gender. The
publisher's model repository is labeled MIT, but it does not include a separate
weight-license file, dataset card, or provenance notice. Hlið retains the
archive's own `LICENSE` and `README.md` files after download.

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

## Windows DirectML TTS runtime

On compatible Windows x64 systems, Hlið can use a separately staged and
verified GPU runtime. Its immutable runtime identifier is
`sherpa-tts-1.13.4-ort-dml-1.24.4-directml-1.15.4-r2-win-x64`. The runtime
artifact carries the complete license and third-party notice files for every
component.

sherpa-onnx 1.13.4:

- Purpose: text-to-speech API and model frontends
- License: Apache License 2.0
- Source revision:
  `https://github.com/k2-fsa/sherpa-onnx/tree/142807252687d81b40d6315f23470a1512a00de3`

ONNX Runtime DirectML 1.24.4:

- Purpose: ONNX inference and DirectML execution provider
- License: MIT
- Package:
  `https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime.DirectML/1.24.4`
- Package SHA-256:
  `57e9f11b73437bef7a309496135d4c1f96b1a8e9ddba60013fa27bfc1d788681`
- Source revision:
  `https://github.com/microsoft/onnxruntime/tree/2d924974ef147392ced8409d36bd6d2e7fcc8a74`

Microsoft.AI.DirectML 1.15.4:

- Purpose: redistributable DirectML runtime
- License: Microsoft DirectML software license terms; included code components
  are separately identified under the MIT license
- Package and license:
  `https://www.nuget.org/packages/Microsoft.AI.DirectML/1.15.4`
- Package SHA-256:
  `4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9`

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
