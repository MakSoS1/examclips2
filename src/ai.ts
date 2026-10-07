import type { ClipCandidate, DeviceCapabilities, Transcript, TranscriptSegment } from "./types";
import { encodeWav16k } from "./engine";

let asrPipeline: any = null;
let textPipeline: any = null;

function normalize(result: any, duration: number, language: string): Transcript {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  let segments: TranscriptSegment[] = chunks.map((chunk: any, index: number) => {
    const ts = Array.isArray(chunk.timestamp) ? chunk.timestamp : [0, 0];
    return {
      id: "asr-" + index,
      start: Number(ts[0] || 0),
      end: Number(ts[1] || ts[0] || 0),
      text: String(chunk.text || "").trim()
    };
  }).filter((segment: TranscriptSegment) => segment.text);

  if (!segments.length && result?.text) {
    segments = [{ id: "asr-0", start: 0, end: duration, text: String(result.text).trim() }];
  }
  return { language, duration, segments };
}

export async function transcribeLocal(
  audio: Float32Array,
  capabilities: DeviceCapabilities,
  language = "ru",
  onStatus?: (message: string) => void
): Promise<Transcript> {
  onStatus?.("Загружаю локальную Whisper");
  const transformers = await import("@huggingface/transformers");
  const device = capabilities.webgpu ? "webgpu" : "wasm";
  const model = capabilities.tier === "HIGH"
    ? "onnx-community/whisper-small"
    : capabilities.tier === "MEDIUM"
      ? "onnx-community/whisper-base"
      : "onnx-community/whisper-tiny";

  if (!asrPipeline) {
    asrPipeline = await transformers.pipeline("automatic-speech-recognition", model, {
      device,
      dtype: capabilities.webgpu ? "q4" : "q8"
    } as any);
  }

  onStatus?.("Распознаю лекцию локально");
  const result = await asrPipeline(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    language: language === "auto" ? undefined : language
  });
  return normalize(result, audio.length / 16000, language);
}

async function transcribeCloudChunk(
  audio: Float32Array,
  language: string,
  providerKey?: string
): Promise<Transcript> {
  const body = new FormData();
  body.append("file", encodeWav16k(audio), "lecture.wav");
  body.append("language", language);
  const headers: Record<string, string> = {};
  if (providerKey?.trim()) headers["X-Provider-Key"] = providerKey.trim();

  const response = await fetch("/api/asr/transcribe", { method: "POST", headers, body });
  if (!response.ok) throw new Error((await response.text()) || "Cloud ASR недоступен");
  return response.json();
}

export async function transcribeCloud(
  audio: Float32Array,
  language: string,
  providerKey?: string,
  onStatus?: (message: string) => void
): Promise<Transcript> {
  // 10 minutes of mono PCM16 at 16 kHz is about 19.2 MB, safely below
  // the 25 MB provider upload limit. A two-second overlap protects words
  // that cross chunk boundaries; duplicate overlapping segments are removed.
  const sampleRate = 16000;
  const chunkSamples = sampleRate * 10 * 60;
  const overlapSamples = sampleRate * 2;
  const step = chunkSamples - overlapSamples;
  const totalChunks = Math.max(1, Math.ceil(Math.max(0, audio.length - overlapSamples) / step));
  const merged: TranscriptSegment[] = [];
  let detectedLanguage = language;
  let lastAcceptedEnd = -1;

  for (let chunkIndex = 0, startSample = 0; startSample < audio.length; chunkIndex++, startSample += step) {
    const endSample = Math.min(audio.length, startSample + chunkSamples);
    const chunk = audio.subarray(startSample, endSample);
    onStatus?.("Cloud ASR: часть " + (chunkIndex + 1) + " из " + totalChunks);

    const result = await transcribeCloudChunk(chunk, language, providerKey);
    if (result.language && result.language !== "unknown") detectedLanguage = result.language;
    const offset = startSample / sampleRate;

    for (const segment of result.segments) {
      const adjusted: TranscriptSegment = {
        id: "cloud-" + chunkIndex + "-" + segment.id,
        start: segment.start + offset,
        end: segment.end + offset,
        text: segment.text
      };

      // Ignore a segment that is fully inside the overlap already emitted.
      if (adjusted.end <= lastAcceptedEnd + 0.35) continue;
      if (adjusted.start < lastAcceptedEnd - 0.8) continue;

      merged.push(adjusted);
      lastAcceptedEnd = Math.max(lastAcceptedEnd, adjusted.end);
    }

    if (endSample >= audio.length) break;
  }

  return {
    language: detectedLanguage,
    duration: audio.length / sampleRate,
    segments: merged
  };
}

function jsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export async function refineCandidatesWithMiniLLM(
  transcript: Transcript,
  candidates: ClipCandidate[],
  capabilities: DeviceCapabilities,
  onStatus?: (message: string) => void
): Promise<ClipCandidate[]> {
  if (!capabilities.webgpu || capabilities.tier === "LOW" || !candidates.length) return candidates;
  onStatus?.("Загружаю mini-LLM");
  const transformers = await import("@huggingface/transformers");

  if (!textPipeline) {
    textPipeline = await transformers.pipeline(
      "text-generation",
      "onnx-community/Qwen2.5-0.5B-Instruct",
      { device: "webgpu", dtype: "q4" } as any
    );
  }

  const top = candidates.slice(0, 8);
  const refined: ClipCandidate[] = [];
  for (let index = 0; index < top.length; index++) {
    const candidate = top[index];
    onStatus?.("Mini-LLM проверяет " + (index + 1) + "/" + top.length);
    const context = transcript.segments
      .filter((s) => s.end >= candidate.start - 15 && s.start <= candidate.end + 15)
      .map((s) => "[" + s.start.toFixed(1) + "-" + s.end.toFixed(1) + "] " + s.text)
      .join("\n")
      .slice(0, 8000);

    const prompt =
      "Оцени образовательный short. Верни только JSON: " +
      "{\"keep\":boolean,\"score\":number,\"title\":string,\"visualDependency\":number,\"reason\":string}. " +
      "score и visualDependency от 0 до 1. Клип должен быть самодостаточным.\n\n" + context;

    try {
      const output = await textPipeline(prompt, { max_new_tokens: 180, temperature: 0.15, do_sample: false });
      const generated = Array.isArray(output) ? String(output[0]?.generated_text || "") : String(output);
      const parsed = jsonObject(generated.slice(prompt.length)) || jsonObject(generated);
      if (parsed) {
        refined.push({
          ...candidate,
          accepted: typeof parsed.keep === "boolean" ? parsed.keep : candidate.accepted,
          score: typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : candidate.score,
          title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 100) : candidate.title,
          visualDependency: typeof parsed.visualDependency === "number"
            ? Math.max(0, Math.min(1, parsed.visualDependency))
            : candidate.visualDependency,
          reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : candidate.reason
        });
        continue;
      }
    } catch {
      // Deterministic ranking is the fallback.
    }
    refined.push(candidate);
  }
  return [...refined, ...candidates.slice(top.length)].sort((a, b) => b.score - a.score);
}
