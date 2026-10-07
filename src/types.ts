export type DeviceTier = "LOW" | "MEDIUM" | "HIGH";
export type PipelineStage =
  | "idle"
  | "probing"
  | "audio"
  | "transcribing"
  | "mapping"
  | "ranking"
  | "visual"
  | "review"
  | "rendering"
  | "done"
  | "error";

export interface DeviceCapabilities {
  webgpu: boolean;
  webcodecs: boolean;
  wasmThreads: boolean;
  cpuThreads: number;
  memoryGB: number | null;
  tier: DeviceTier;
}

export interface MediaInfo {
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  type: string;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  language: string;
  duration: number;
  segments: TranscriptSegment[];
}

export interface LectureSection {
  id: string;
  start: number;
  end: number;
  title: string;
  segments: TranscriptSegment[];
}

export type LayoutMode =
  | "SMART_CROP"
  | "SPEAKER_FULL"
  | "SLIDE_FULL"
  | "SPEAKER_TOP_SLIDE_BOTTOM";

export interface VisualAnalysis {
  faceDetected: boolean;
  faceX: number;
  faceY: number;
  sceneChanges: number[];
  layout: LayoutMode;
}

export interface ClipCandidate {
  id: string;
  start: number;
  end: number;
  title: string;
  score: number;
  accepted: boolean;
  reason: string;
  visualDependency: number;
  visual?: VisualAnalysis;
}

export interface PipelineProgress {
  stage: PipelineStage;
  progress: number;
  message: string;
}

export interface SavedProject {
  id: string;
  name: string;
  media: MediaInfo;
  transcript?: Transcript;
  candidates?: ClipCandidate[];
  updatedAt: string;
}
