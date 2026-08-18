# Local neural TTS qualification

Hlid enables a neural TTS backend only for an exact model and runtime pair that
has passed the checks below. Loading an ONNX graph is not sufficient.

Run the repository-owned Windows harness with
`scripts/run-tts-qualification.ps1`. It invokes
`scripts/qualify-tts-model.ts` in an isolated Bun process and writes the full
result, representative WAV, logs, and GPU counter evidence to a new output
directory.

## Qualification checks

- The upstream model archive, byte size, SHA-256, required files, model card,
  and license lineage are recorded before testing.
- The model is tested without editing or rewriting its ONNX graph.
- Model-specific inference values are pinned in both the catalog and harness.
  A run using a generic runtime default does not qualify a different production
  setting.
- A fresh process initializes the exact runtime and synthesizes one cold sample,
  six warm repetitions, and four production-sized chunks of 266 to 300
  characters through one persistent model handle.
- Output must have a valid sample rate, finite samples, non-silent content,
  stable amplitude, no clipping, and no material DC offset.
- Representative output is transcribed with local Whisper as an intelligibility
  proxy. An outlier or a material regression against an existing qualified
  control requires more passages or a manual audition before catalog inclusion.
- A DirectML pass requires both a `directml` provider configuration and
  nonzero process-scoped Windows GPU Engine counters. Provider selection alone
  does not prove that inference used the GPU.
- CPU fallback is tested with the separately distributed official CPU runtime.
  Its result is recorded even when it is too slow for uninterrupted playback.
- Any native crash, corrupt audio, incompatible graph, unresolved license, or
  incomplete product workflow keeps that model out of the supported catalog.

## Qualified matrix

The current matrix was measured on 2026-08-16 and 2026-08-17 with Windows 11
Pro build 26200, an AMD Ryzen 9 5950X, an AMD Radeon RX 6700 XT, and AMD driver
32.0.21045.1000. The CPU runtime is official sherpa-onnx 1.13.4. The GPU
runtime is `sherpa-tts-1.13.4-ort-dml-1.24.4-directml-1.15.4-r2-win-x64`.
Release builds pin MSVC 14.44.35207 and reproducible compiler and linker flags
so CI can rebuild and match the exact runtime bytes qualified on that GPU.

Real-time factor is synthesis time divided by generated audio duration. Values
below 1 are faster than playback. Direct comparisons use the same model,
runtime harness, four threads, text, and warm-up policy.

| Model | CPU | DirectML | DirectML evidence | Direct comparison |
| --- | --- | --- | ---: | ---: |
| Kitten Nano v0.8 INT8 | Qualified | Not qualified | - | - |
| Piper Kristin Medium INT8 | Qualified | Qualified | Long-text RTF 0.03363 | - |
| Piper Bryce Medium INT8 | Qualified | Qualified | Long-text RTF 0.02638 | - |
| Piper Norman Medium INT8 | Qualified, long-text RTF 0.23564 | Qualified | Long-text RTF 0.03400 | 6.93x long-text |
| Piper Cori Medium INT8 | Qualified | Qualified | Warm RTF 0.02082 | - |
| Piper LJSpeech High INT8 | Qualified, long-text RTF 1.49017 | Qualified | Long-text RTF 0.07669 | 19.43x long-text |
| Piper LibriTTS High INT8 `p3922`, `sid 0` | Qualified, long-text RTF 1.47732 | Qualified | Long-text RTF 0.08107 | 18.22x long-text |
| Piper LibriTTS High INT8 `p6701`, `sid 3` | Qualified, long-text RTF 1.51353 | Qualified | Long-text RTF 0.08034 | 18.84x long-text |
| Piper LibriTTS High INT8 `p922`, `sid 5` | Qualified, long-text RTF 1.51348 | Qualified | Long-text RTF 0.08175 | 18.51x long-text |
| Piper LibriTTS High INT8 `p8152`, `sid 132` | Qualified, long-text RTF 1.47985 | Qualified | Long-text RTF 0.07939 | 18.64x long-text |
| Piper LibriTTS High INT8 `p2085`, `sid 903` | Qualified, long-text RTF 1.47883 | Qualified | Long-text RTF 0.07919 | 18.67x long-text |
| MeloTTS American English `sid 0` | Qualified, long-text RTF 0.32893 | Qualified | Long-text RTF 0.10918 | 3.01273x long-text |
| MeloTTS British English `sid 1` | Qualified, long-text RTF 0.33697 | Qualified | Long-text RTF 0.11830 | 2.848x long-text |
| MeloTTS Indian English `sid 2` | Qualified, long-text RTF 0.33384 | Qualified | Long-text RTF 0.11366 | 2.93718x long-text |
| MeloTTS Australian English `sid 3` | Qualified, long-text RTF 0.34618 | Qualified | Long-text RTF 0.10708 | 3.23291x long-text |
| MeloTTS Default English `sid 4` | Qualified, long-text RTF 0.33161 | Qualified | Long-text RTF 0.12143 | 2.73087x long-text |

The DirectML runs reached process-scoped GPU Engine maxima of 50.40% for
Kristin, 53.67% for Bryce, 48.00% for Norman, 50.86% for Cori Medium, and 83.73%
for LJSpeech High on the qualification GPU. The five LibriTTS voices reached
83.90% for `p3922`, 83.33% for `p6701`, 88.02% for `p922`, 83.29% for `p8152`,
and 82.64% for `p2085`. The five MeloTTS voices reached 48.51% for American,
47.28% for British, 48.34% for Indian, 43.55% for Australian, and 42.32% for
Default English. Raw Whisper small.en word-error rates were 2.56% over 39 words
for Kristin, 5.13% over 39 words for Bryce, 3.50% over 143 words for Cori
Medium, and 1.65% over 182 words for LJSpeech High. Norman and LibriTTS
curation used the currently installed large-v3-turbo-q5_0 model instead;
Norman's Vulkan-backed check had zero edits over 39 words. `p3922`, `p8152`,
and `p2085` had exact edit rates of 4.88%, 6.10%, and 1.22% over 82 words;
number normalization reduced those first two rates to 0% and 1.22%. The
`p6701` and `p922` controls scored 2.56% and 5.13% over a 39-word passage.
Those figures rank candidate voices within one run and are not directly
comparable to the earlier small.en results. Transcriptions are a regression
signal rather than a substitute for judging voice preference.

The reproducible `r2` release runtime was rebuilt independently in two CI jobs.
Both produced archive SHA-256
`72fda918fc7196b522a1c4f2cd29bfbfa5d31f7a4810c3c79b0bde63448e1057`
and C API SHA-256
`0eccb0f445f0dfa81f26c9de2633da34fcf681b0513b9209bdc5dc14f5b9b1ac`.
That exact artifact then passed the full Cori DirectML harness on the
qualification GPU: 11 syntheses through one persistent handle, 50.855244% peak
GPU Engine activity, warm RTF 0.02082, production RTF 0.03109, no clipped
samples, peak amplitude 0.395782, and maximum DC-to-RMS ratio 0.002728.

LJSpeech High produces valid CPU audio, but its measured CPU RTF is above 1 on
the qualification machine. It is intended for DirectML use when continuous
long-form playback matters. Hlid retains CPU as a safe fallback, and reports
that fallback rather than silently claiming GPU acceleration. Its upstream
archive identifier says `High`, while the bundled model card records medium
quality training settings, so Forge presents it in the balanced tier.

Norman Medium INT8 is an unchanged single-speaker US English Piper graph. Its
CPU and DirectML runs each completed 11 syntheses through one persistent model
handle. CPU initialization took 1,727.701 ms, warm RTF was 0.24003, and
long-text RTF was 0.23564. DirectML initialization took 2,652.675 ms, warm RTF
was 0.02185, and long-text RTF was 0.03400, a 6.93x long-text speedup. The
process-scoped GPU trace reached 47.995726%, and local Whisper transcribed the
representative 39-word passage with zero edits. All 22 outputs were finite and
audible with no clipped samples and a maximum DC-to-RMS ratio of 0.003422. The
exact archive is 20,987,233 bytes with SHA-256
`cb481a514bc213ccf3899391c0f27fdcc4e4b814ec30496f28089a027b5aa01b`.
Its archive carries a `MODEL_CARD` identifying public-domain LibriVox training
data. The catalog attributes MIT to the Piper repository and does not claim
that the downloaded archive includes a separate standalone model license.

LibriTTS High is an unchanged 904-speaker model trained from scratch on the
CC BY 4.0 LibriTTS `train-clean-360` corpus. Hlið exposes five approved
speakers, using the source corpus metadata only for presentation: feminine
`p3922` (`sid 0`), masculine `p6701` (`sid 3`), masculine `p922` (`sid 5`),
masculine `p8152` (`sid 132`), and feminine `p2085` (`sid 903`). Each exposed
speaker independently passed the complete CPU and DirectML suite using one
persistent handle per run. Their CPU/DirectML long-text RTF and speedups were
1.47732/0.08107 and 18.22x for `p3922`, 1.51353/0.08034 and 18.84x for `p6701`,
1.51348/0.08175 and 18.51x for `p922`, 1.47985/0.07939 and 18.64x for `p8152`,
and 1.47883/0.07919 and 18.67x for `p2085`. Across their 110 measured
syntheses, all output was finite and audible with no clipping; the maximum
DC-to-RMS ratio was 0.014484.

All other speaker IDs remain unexposed. Documented rejection evidence includes
`p4535`, which produced a 28.21% within-run Whisper word-error rate; `p2531`,
which produced a DC-to-RMS ratio of 0.277643 against the 0.05 limit; and `p711`
(`sid 767`), which was rejected during human audition even though it passed the
technical CPU, DirectML, safety, and transcription gates. The model's `en_US`
frontend tag is not evidence of an individual reader's accent, so Forge makes
no accent claim for any exposed voice.

MeloTTS English is an unchanged five-speaker model converted from MyShell's
published checkpoint. Hlið exposes the publisher-labeled American `EN-US`
(`sid 0`), British `EN-BR` (`sid 1`), Indian `EN_INDIA` (`sid 2`), Australian
`EN-AU` (`sid 3`), and Default `EN-Default` (`sid 4`) speakers. Default English
is explicitly an unspecified publisher default, not an accent claim. The
frontend uses the archive's `lexicon.txt` directly and does not invent an
eSpeak-ng data directory. Production pins the upstream MeloTTS settings
`noiseScale=0.6` and `noiseScaleW=0.8`; measurements made with sherpa's generic
VITS noise default do not qualify this catalog entry.

At those pinned settings, the British speaker passed the complete CPU and
DirectML suite through one persistent handle per run. CPU long-text RTF was
0.33697 and DirectML RTF was 0.11830, a 2.848x speedup. DirectML initialization
took 2,288 ms. Its process-scoped GPU trace contained 210 records, 14 positive
records, and a 47.278% maximum. Across 22 syntheses, every output was finite and
audible, with no clipped samples, a maximum peak of 0.666968, and maximum
DC-to-RMS ratio of 0.001939. The exact archive is 162,758,237 bytes with SHA-256
`f87bc5752ea3ec34273a2cc0c5086854c18b6b89dfd0534b5248e86a14cedb5d`;
the unchanged ONNX graph has SHA-256
`5f72fbbc4105b008de8141049c0535b7a99a527ddb80fcbc0c0ac8a046997544`.

The other four exposed speakers passed the same exact CPU and DirectML policy
at the same pinned settings. American measured CPU/DML long-text RTF
0.32893/0.10918, a 3.01273x speedup; Indian measured 0.33384/0.11366, a
2.93718x speedup; Australian measured 0.34618/0.10708, a 3.23291x speedup; and
Default English measured 0.33161/0.12143, a 2.73087x speedup. Their respective
DirectML GPU Engine maxima were 48.513143%, 48.336072%, 43.545639%, and
42.319865%. Each DirectML trace contained 210 records with 14 positive records.
All 88 additional syntheses were finite and audible, had no clipped samples,
and remained within the qualification amplitude and DC-offset limits. The user
also approved all five voices through manual sampler review; the automated
shipping-configuration gates above remain the separate technical evidence.

The archive contains MyShell.ai's MIT notice and its metadata declares MIT.
The publisher does not identify the checkpoint's training datasets, audio
provenance, source-speaker identity, or speaker consent. Hlið records that
missing provenance explicitly and makes no gender or identity claim.

## Deferred models

- Cori High INT8 passed CPU and DirectML integrity and performance checks, but
  its combined four-passage Whisper small.en word-error rate was 8.79%,
  including one 17.95% outlier passage. It remains out of the catalog pending a
  favorable manual voice-quality and intelligibility audition.
- Kitten Mini and unmodified Kokoro graphs encounter the released DirectML
  runtime's one-dimensional `ConvTranspose` adapter defect. They remain
  unsupported until an official runtime containing the upstream fix is
  released and the unchanged graphs pass the full matrix.
- Kokoro INT8 also has a separate native initialization failure and is not
  covered by the `ConvTranspose` fix alone.
- Pocket TTS produced corrupt or non-finite DirectML output on the released
  runtime and requires a reference-audio workflow.
- ZipVoice requires reference audio and a matching transcript. It is a voice
  cloning workflow rather than a drop-in read-aloud voice.
- Supertonic 3 INT8 terminated natively during its isolated CPU qualification.
  Its model license and upstream support status also require separate review.
- Matcha LJSpeech is blocked by inconsistent upstream archive checksum
  metadata and requires a second model family and vocoder.
These deferrals are not permanent model bans. Each one records the next
specific gate, so a runtime or product change can be retested without weakening
the qualification standard.
