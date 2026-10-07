# MVP status

## Goal

ExamClips2 turns a long educational lecture into a small ranked set of vertical shorts while keeping the permanent infrastructure CPU-only.

The default architecture is deliberately local-first and progressive:

```text
local video File
  -> lazy audio-only chunks
  -> ASR
  -> lecture map
  -> cheap candidate filter
  -> optional local mini-LLM on top candidates
  -> sparse visual analysis only on top candidates
  -> preview
  -> user accepts/edits
  -> local 1080x1920 render only for accepted clips
```

## MVP implemented

### Browser compute

- capability benchmark: WebGPU, WebCodecs, WASM threads, CPU threads, coarse device tier;
- local IndexedDB project state;
- local Whisper fallback through Transformers.js;
- default weak-device cloud-ASR media path through Mediabunny:
  - lazy BlobSource;
  - no full source-video upload;
  - video track discarded;
  - approximately 10-minute chunks;
  - two-second overlap;
  - Opus 24 kbps;
  - mono 16 kHz;
  - timestamps merged back to the lecture timeline;
- deterministic lecture sections and candidate windows;
- heuristic educational ranking;
- optional Qwen2.5 0.5B local verifier on WebGPU;
- sparse 320x180 candidate-only visual sampling;
- scene-change detection;
- optional native browser face detection;
- optional native browser text detection;
- automatic layout selection;
- live vertical preview;
- manual start/end adjustment and accept/reject;
- local 1080x1920 rendering with subtitles;
- MP4 transcode attempt with WebM fallback.

### Layouts

- SMART_CROP: keeps a detected speaker near the crop focus;
- SLIDE_FULL: preserves the complete wide source in a readable vertical composition;
- SPEAKER_TOP_SLIDE_BOTTOM: full slide/screen region plus speaker-focused crop.

### Thin VPS control plane

- FastAPI;
- SQLAlchemy;
- PostgreSQL production / SQLite development fallback;
- project metadata/state endpoints;
- ASR proxy that accepts audio only;
- shared key or BYOK header;
- provider key is not persisted;
- source video is not stored by the backend.

### Deployment

- frontend production Docker image;
- backend production Docker image;
- nginx SPA/API proxy;
- PostgreSQL Docker Compose stack;
- environment template.

### CI on GitHub Actions

The branch is validated on clean Ubuntu GitHub-hosted VMs with:

- production dependency audit at high severity;
- frontend unit tests;
- TypeScript typecheck and Vite production build;
- backend pytest;
- Docker Compose validation;
- production Docker image build.

## Privacy boundary

Default cloud-assisted mode sends only short compressed audio chunks to the configured ASR provider. Video frames, sparse visual analysis, layout decisions and final rendering remain in the browser.

Local ASR mode keeps audio local as well.

## Known MVP limitations

These are not blockers for the first usable MVP but are intentionally documented:

1. Local-only Whisper still decodes the complete audio track before inference. The default cloud-assisted path does not have this memory behavior.
2. FaceDetector and TextDetector are optional browser APIs. Their absence falls back to semantic dependency plus deterministic center/slide layouts.
3. The mini-LLM is a generic local verifier, not a custom distilled ExamClips model yet.
4. A dedicated distilled candidate classifier/boundary model belongs to the post-MVP learning loop, once real accept/reject and boundary-edit feedback exists.
5. MP4 conversion can fall back to WebM if ffmpeg.wasm cannot initialize on a particular browser/device.
6. Cross-device source-video continuation is intentionally not part of zero-storage MVP; source media stays local.

## Post-MVP learning loop

The next model milestone should use opt-in feedback:

```text
teacher labels
+ accepted/rejected clips
+ boundary edits
+ layout corrections
  -> candidate classifier
  -> boundary model
  -> visual-dependency classifier
  -> tiny title/generative model
```

This lets the product progressively replace a general mini-LLM with smaller specialist models without changing the rest of the pipeline.
