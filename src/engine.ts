import { openDB } from "idb";
import type {
  ClipCandidate, DeviceCapabilities, LectureSection, MediaInfo, SavedProject,
  Transcript, TranscriptSegment, VisualAnalysis
} from "./types";

async function database() {
  return openDB("examclips2", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
    }
  });
}

export async function saveProject(project: SavedProject) {
  const db = await database();
  await db.put("projects", project);
}

export async function benchmarkDevice(): Promise<DeviceCapabilities> {
  const nav = navigator as Navigator & { gpu?: unknown; deviceMemory?: number };
  const cpuThreads = Math.max(1, navigator.hardwareConcurrency || 2);
  const memoryGB = typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
  const webgpu = Boolean(nav.gpu);
  const webcodecs = "VideoEncoder" in window && "VideoDecoder" in window;
  const wasmThreads = typeof SharedArrayBuffer !== "undefined";
  let tier: DeviceCapabilities["tier"] = "LOW";
  if (webgpu && cpuThreads >= 8 && (memoryGB === null || memoryGB >= 8)) tier = "HIGH";
  else if ((webgpu || webcodecs) && cpuThreads >= 4) tier = "MEDIUM";
  return { webgpu, webcodecs, wasmThreads, cpuThreads, memoryGB, tier };
}

export async function inspectMedia(file: File): Promise<MediaInfo> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Не удалось прочитать метаданные видео"));
      video.src = url;
    });
    return {
      name: file.name,
      size: file.size,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      width: video.videoWidth,
      height: video.videoHeight,
      type: file.type || "video/*"
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function resample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let i = 0; i < output.length; i++) {
    const p = i * ratio;
    const left = Math.floor(p);
    const right = Math.min(input.length - 1, left + 1);
    const w = p - left;
    output[i] = input[left] * (1 - w) + input[right] * w;
  }
  return output;
}

export async function extractAudio16k(file: File, onProgress?: (p: number) => void) {
  onProgress?.(0.05);
  const buffer = await file.arrayBuffer();
  onProgress?.(0.2);
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(buffer.slice(0));
    onProgress?.(0.65);
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    const audio = resample(mono, decoded.sampleRate, 16000);
    onProgress?.(1);
    return audio;
  } finally {
    await context.close();
  }
}

export function encodeWav16k(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const markers = [
  "важно", "почему", "например", "рассмотрим", "получается", "следовательно",
  "итак", "запомните", "обратите внимание", "означает", "определение", "идея"
];
const weakStart = ["это", "этот", "эта", "эти", "тут", "здесь", "туда", "сюда", "поэтому"];

function scoreWindow(segments: TranscriptSegment[]) {
  const text = segments.map((s) => s.text).join(" ").trim();
  const lower = text.toLowerCase();
  const duration = Math.max(1, segments[segments.length - 1].end - segments[0].start);
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = 0.35 + Math.min(0.22, words / 450);
  score += markers.filter((m) => lower.includes(m)).length * 0.035;
  const firstWord = lower.replace(/^[^а-яa-z0-9]+/i, "").split(/\s+/)[0];
  if (weakStart.includes(firstWord)) score -= 0.12;
  if (duration >= 35 && duration <= 90) score += 0.16;
  if (duration > 110 || words < 45) score -= 0.12;
  if (/[?]/.test(text) && /(потому|ответ|получается|значит)/i.test(text)) score += 0.08;
  return Math.max(0, Math.min(0.99, score));
}

function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  const first = clean.split(/[.!?]/)[0].trim();
  if (first.length >= 18 && first.length <= 92) return first;
  const words = clean.split(/\s+/).slice(0, 10).join(" ");
  return words.length > 80 ? words.slice(0, 77) + "…" : words || "Фрагмент лекции";
}

export function buildLectureMap(transcript: Transcript): LectureSection[] {
  const segments = transcript.segments;
  if (!segments.length) return [];
  const sections: LectureSection[] = [];
  let current: TranscriptSegment[] = [];
  let sectionStart = segments[0].start;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    current.push(segment);
    const elapsed = segment.end - sectionStart;
    const gapNext = (segments[i + 1]?.start || segment.end) - segment.end;
    if (elapsed >= 240 || (elapsed >= 90 && gapNext > 2.2)) {
      const text = current.map((s) => s.text).join(" ");
      sections.push({
        id: "section-" + sections.length,
        start: current[0].start,
        end: current[current.length - 1].end,
        title: titleFrom(text),
        segments: current
      });
      current = [];
      sectionStart = segment.end;
    }
  }
  if (current.length) {
    const text = current.map((s) => s.text).join(" ");
    sections.push({
      id: "section-" + sections.length,
      start: current[0].start,
      end: current[current.length - 1].end,
      title: titleFrom(text),
      segments: current
    });
  }
  return sections;
}

export function generateCandidates(transcript: Transcript, maxCandidates = 16): ClipCandidate[] {
  const segments = transcript.segments;
  const candidates: ClipCandidate[] = [];
  for (let startIndex = 0; startIndex < segments.length; startIndex++) {
    let endIndex = startIndex;
    while (endIndex < segments.length && segments[endIndex].end - segments[startIndex].start < 42) endIndex++;
    if (endIndex >= segments.length) break;
    while (endIndex + 1 < segments.length) {
      const nextDuration = segments[endIndex + 1].end - segments[startIndex].start;
      if (nextDuration > 88) break;
      endIndex++;
    }
    const window = segments.slice(startIndex, endIndex + 1);
    const score = scoreWindow(window);
    if (score >= 0.45) {
      const text = window.map((s) => s.text).join(" ");
      candidates.push({
        id: "clip-" + startIndex + "-" + endIndex,
        start: window[0].start,
        end: window[window.length - 1].end,
        title: titleFrom(text),
        score,
        accepted: score >= 0.68,
        reason: score >= 0.72 ? "Самодостаточное объяснение с хорошей плотностью смысла" : "Сильный кандидат по структуре речи",
        visualDependency: /(слайд|график|формул|здесь|сюда|на экране|видите)/i.test(text) ? 0.75 : 0.25
      });
    }
    startIndex = Math.max(startIndex, endIndex - 1);
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((candidate, index, all) => !all.slice(0, index).some((prev) => {
      const overlap = Math.max(0, Math.min(prev.end, candidate.end) - Math.max(prev.start, candidate.start));
      const shortest = Math.min(prev.end - prev.start, candidate.end - candidate.start);
      return shortest > 0 && overlap / shortest > 0.7;
    }))
    .slice(0, maxCandidates);
}

async function seek(video: HTMLVideoElement, time: number) {
  if (Math.abs(video.currentTime - time) < 0.04) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("Seek failed")); };
    const cleanup = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.currentTime = Math.max(0, Math.min(video.duration || time, time));
  });
}

function frameDifference(a: Uint8ClampedArray | null, b: Uint8ClampedArray) {
  if (!a || a.length !== b.length) return 1;
  let total = 0;
  for (let i = 0; i < b.length; i += 16) {
    total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return total / ((b.length / 16) * 255 * 3);
}

export async function analyzeCandidateVisual(sourceUrl: string, start: number, end: number): Promise<VisualAnalysis> {
  const video = document.createElement("video");
  video.src = sourceUrl;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Visual decode failed"));
  });

  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");

  type FaceDetectorLike = { detect: (source: CanvasImageSource) => Promise<Array<{ boundingBox: DOMRectReadOnly }>> };
  type TextDetection = { rawValue?: string; boundingBox: DOMRectReadOnly };
  type TextDetectorLike = { detect: (source: CanvasImageSource) => Promise<TextDetection[]> };

  const browser = window as unknown as {
    FaceDetector?: new (o?: object) => FaceDetectorLike;
    TextDetector?: new () => TextDetectorLike;
  };
  const faceDetector = browser.FaceDetector ? new browser.FaceDetector({ fastMode: true, maxDetectedFaces: 2 }) : null;
  const textDetector = browser.TextDetector ? new browser.TextDetector() : null;

  let previous: Uint8ClampedArray | null = null;
  const sceneChanges: number[] = [];
  const faces: Array<{ x: number; y: number }> = [];
  const textSnippets = new Set<string>();
  let textAreaRatioTotal = 0;
  let textSamples = 0;
  const duration = Math.max(1, end - start);
  const count = Math.min(12, Math.max(4, Math.ceil(duration / 6)));

  for (let i = 0; i < count; i++) {
    const time = start + duration * i / Math.max(1, count - 1);
    await seek(video, time);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const diff = frameDifference(previous, image.data);
    if (previous && diff > 0.16) sceneChanges.push(time);
    previous = new Uint8ClampedArray(image.data);

    if (faceDetector) {
      try {
        const found = await faceDetector.detect(canvas);
        if (found[0]) {
          const box = found[0].boundingBox;
          faces.push({
            x: (box.x + box.width / 2) / canvas.width,
            y: (box.y + box.height / 2) / canvas.height
          });
        }
      } catch {
        // Optional native browser detector.
      }
    }

    const shouldReadText = textDetector && (i === 0 || i === count - 1 || diff > 0.16);
    if (shouldReadText) {
      try {
        const foundText = await textDetector.detect(canvas);
        let area = 0;
        for (const detection of foundText) {
          const box = detection.boundingBox;
          area += Math.max(0, box.width * box.height);
          const value = String(detection.rawValue || "").trim();
          if (value && textSnippets.size < 12) textSnippets.add(value.slice(0, 120));
        }
        textAreaRatioTotal += Math.min(1, area / (canvas.width * canvas.height));
        textSamples++;
      } catch {
        // Optional TextDetector is not available consistently across browsers.
      }
    }
  }

  const faceDetected = faces.length >= Math.max(1, Math.floor(count / 3));
  const faceX = faceDetected ? faces.reduce((sum, f) => sum + f.x, 0) / faces.length : 0.5;
  const faceY = faceDetected ? faces.reduce((sum, f) => sum + f.y, 0) / faces.length : 0.5;
  const textDensity = textSamples ? textAreaRatioTotal / textSamples : 0;
  const snippets = [...textSnippets];
  const textDetected = snippets.length > 0 || textDensity > 0.025;

  return {
    faceDetected,
    faceX,
    faceY,
    sceneChanges,
    textDetected,
    textDensity,
    textSnippets: snippets,
    layout: faceDetected ? "SMART_CROP" : "SLIDE_FULL"
  };
}

export function transcriptFromText(text: string, duration: number, language = "ru"): Transcript {
  const paragraphs = text.split(/\n+/).map((value) => value.trim()).filter(Boolean);
  if (!paragraphs.length) return { language, duration, segments: [] };
  const slice = duration / paragraphs.length;
  return {
    language,
    duration,
    segments: paragraphs.map((value, i) => ({
      id: "manual-" + i,
      start: i * slice,
      end: Math.min(duration, (i + 1) * slice),
      text: value
    }))
  };
}
