import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { ClipCandidate, TranscriptSegment } from "./types";

function activeCaption(segments: TranscriptSegment[], time: number) {
  return segments.find((segment) => time >= segment.start && time <= segment.end)?.text || "";
}

function drawVerticalFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  candidate: ClipCandidate,
  width: number,
  height: number
) {
  ctx.fillStyle = "#0F1115";
  ctx.fillRect(0, 0, width, height);

  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = video.videoWidth;
  let sh = video.videoHeight;

  if (sourceRatio > targetRatio) {
    sw = video.videoHeight * targetRatio;
    const focus = candidate.visual?.faceDetected ? candidate.visual.faceX : 0.5;
    sx = Math.max(0, Math.min(video.videoWidth - sw, focus * video.videoWidth - sw / 2));
  } else {
    sh = video.videoWidth / targetRatio;
    sy = Math.max(0, (video.videoHeight - sh) / 2);
  }

  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
}

async function transcodeToMp4(blob: Blob): Promise<Blob> {
  const ffmpeg = new FFmpeg();
  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  await ffmpeg.load({
    coreURL: await toBlobURL(base + "/ffmpeg-core.js", "text/javascript"),
    wasmURL: await toBlobURL(base + "/ffmpeg-core.wasm", "application/wasm")
  });
  await ffmpeg.writeFile("input.webm", await fetchFile(blob));
  await ffmpeg.exec([
    "-i", "input.webm",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "22",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "output.mp4"
  ]);
  const data = await ffmpeg.readFile("output.mp4");
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  ffmpeg.terminate();
  return new Blob([bytes], { type: "video/mp4" });
}

export async function renderCandidate(
  sourceUrl: string,
  candidate: ClipCandidate,
  transcript: TranscriptSegment[],
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const video = document.createElement("video");
  video.src = sourceUrl;
  video.crossOrigin = "anonymous";
  video.playsInline = true;
  video.preload = "auto";

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Не удалось открыть видео для рендера"));
  });

  const width = 720;
  const height = 1280;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas renderer недоступен");

  const canvasStream = canvas.captureStream(30);
  const audioContext = new AudioContext();
  const source = audioContext.createMediaElementSource(video);
  const destination = audioContext.createMediaStreamDestination();
  source.connect(destination);
  source.connect(audioContext.destination);
  const audioTrack = destination.stream.getAudioTracks()[0];
  if (audioTrack) canvasStream.addTrack(audioTrack);

  const mimeCandidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  const mimeType = mimeCandidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 5_000_000
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };

  await new Promise<void>((resolve, reject) => {
    const onSeek = async () => {
      try {
        recorder.start(500);
        await video.play();

        const draw = () => {
          if (video.ended || video.currentTime >= candidate.end) {
            video.pause();
            if (recorder.state !== "inactive") recorder.stop();
            return;
          }

          drawVerticalFrame(ctx, video, candidate, width, height);
          const caption = activeCaption(transcript, video.currentTime);
          if (caption) {
            ctx.save();
            ctx.font = "600 32px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const maxWidth = width - 96;
            const words = caption.split(/\s+/);
            const lines: string[] = [];
            let line = "";
            for (const word of words) {
              const next = line ? line + " " + word : word;
              if (ctx.measureText(next).width > maxWidth && line) {
                lines.push(line);
                line = word;
              } else {
                line = next;
              }
              if (lines.length >= 2) break;
            }
            if (line && lines.length < 2) lines.push(line);
            const boxHeight = lines.length * 42 + 28;
            ctx.fillStyle = "rgba(15,17,21,0.78)";
            ctx.fillRect(32, height - boxHeight - 86, width - 64, boxHeight);
            ctx.fillStyle = "#FFFFFF";
            lines.forEach((value, i) => {
              ctx.fillText(value, width / 2, height - boxHeight - 66 + 42 * i + 28);
            });
            ctx.restore();
          }

          const progress = (video.currentTime - candidate.start) / Math.max(0.01, candidate.end - candidate.start);
          onProgress?.(Math.max(0, Math.min(1, progress)));
          requestAnimationFrame(draw);
        };
        draw();
      } catch (error) {
        reject(error);
      }
    };

    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(recorder.error || new Error("Ошибка MediaRecorder"));
    video.addEventListener("seeked", onSeek, { once: true });
    video.currentTime = candidate.start;
  });

  await audioContext.close();
  canvasStream.getTracks().forEach((track) => track.stop());

  const recorded = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
  if (recorded.type.includes("mp4")) return recorded;

  try {
    onProgress?.(0.97);
    return await transcodeToMp4(recorded);
  } catch {
    return recorded;
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
