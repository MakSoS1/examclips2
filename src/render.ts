import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { ClipCandidate, TranscriptSegment } from "./types";

function captionAt(segments: TranscriptSegment[], time: number) {
  return segments.find((segment) => time >= segment.start && time <= segment.end)?.text || "";
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  focusX = 0.5
) {
  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = dw / dh;
  let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;

  if (sourceRatio > targetRatio) {
    sw = video.videoHeight * targetRatio;
    sx = Math.max(0, Math.min(video.videoWidth - sw, focusX * video.videoWidth - sw / 2));
  } else {
    sh = video.videoWidth / targetRatio;
    sy = Math.max(0, (video.videoHeight - sh) / 2);
  }
  ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const scale = Math.min(dw / video.videoWidth, dh / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const x = dx + (dw - width) / 2;
  const y = dy + (dh - height) / 2;
  ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, x, y, width, height);
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  candidate: ClipCandidate,
  width: number,
  height: number
) {
  ctx.fillStyle = "#0F1115";
  ctx.fillRect(0, 0, width, height);

  const layout = candidate.visual?.layout || "SMART_CROP";
  const focusX = candidate.visual?.faceDetected ? candidate.visual.faceX : 0.5;

  if (layout === "SLIDE_FULL") {
    // A dimmed cover frame fills the unused vertical background while the
    // complete source stays readable in the middle.
    ctx.save();
    ctx.globalAlpha = 0.28;
    drawCover(ctx, video, 0, 0, width, height, 0.5);
    ctx.restore();
    ctx.fillStyle = "rgba(15,17,21,.48)";
    ctx.fillRect(0, 0, width, height);
    drawContain(ctx, video, 48, 190, width - 96, height - 520);
    return;
  }

  if (layout === "SPEAKER_TOP_SLIDE_BOTTOM") {
    const slideHeight = Math.round(height * 0.58);
    const speakerY = slideHeight + 20;
    const speakerHeight = height - speakerY;

    ctx.fillStyle = "#0B0D12";
    ctx.fillRect(0, 0, width, slideHeight);
    drawContain(ctx, video, 28, 36, width - 56, slideHeight - 72);

    ctx.fillStyle = "#151922";
    ctx.fillRect(0, slideHeight, width, 20);
    drawCover(ctx, video, 0, speakerY, width, speakerHeight, focusX);
    return;
  }

  drawCover(ctx, video, 0, 0, width, height, focusX);
}

async function toMp4(blob: Blob): Promise<Blob> {
  const ffmpeg = new FFmpeg();
  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  await ffmpeg.load({
    coreURL: await toBlobURL(base + "/ffmpeg-core.js", "text/javascript"),
    wasmURL: await toBlobURL(base + "/ffmpeg-core.wasm", "application/wasm")
  });
  await ffmpeg.writeFile("input.webm", await fetchFile(blob));
  await ffmpeg.exec([
    "-i", "input.webm", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "output.mp4"
  ]);
  const data = await ffmpeg.readFile("output.mp4");
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  ffmpeg.terminate();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: "video/mp4" });
}

export async function renderCandidate(
  sourceUrl: string,
  candidate: ClipCandidate,
  transcript: TranscriptSegment[],
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const video = document.createElement("video");
  video.src = sourceUrl;
  video.playsInline = true;
  video.preload = "auto";
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Не удалось открыть видео для рендера"));
  });

  const width = 1080, height = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas renderer недоступен");

  const stream = canvas.captureStream(30);
  const audioContext = new AudioContext();
  const source = audioContext.createMediaElementSource(video);
  const destination = audioContext.createMediaStreamDestination();
  source.connect(destination);
  const audioTrack = destination.stream.getAudioTracks()[0];
  if (audioTrack) stream.addTrack(audioTrack);

  const mimeTypes = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  const mimeType = mimeTypes.find((value) => MediaRecorder.isTypeSupported(value)) || "";
  const recorder = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: 8_000_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };

  await new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("MediaRecorder error"));
    video.addEventListener("seeked", async () => {
      try {
        recorder.start(500);
        await video.play();
        const draw = () => {
          if (video.ended || video.currentTime >= candidate.end) {
            video.pause();
            if (recorder.state !== "inactive") recorder.stop();
            return;
          }

          drawFrame(ctx, video, candidate, width, height);
          const text = captionAt(transcript, video.currentTime);
          if (text) {
            ctx.save();
            ctx.font = "600 44px system-ui, sans-serif";
            ctx.textAlign = "center";
            const maxWidth = width - 144;
            const words = text.split(/\s+/);
            const lines: string[] = [];
            let line = "";
            for (const word of words) {
              const next = line ? line + " " + word : word;
              if (ctx.measureText(next).width > maxWidth && line) {
                lines.push(line);
                line = word;
              } else line = next;
              if (lines.length >= 2) break;
            }
            if (line && lines.length < 2) lines.push(line);
            const boxHeight = lines.length * 58 + 36;
            ctx.fillStyle = "rgba(15,17,21,.8)";
            ctx.fillRect(48, height - boxHeight - 126, width - 96, boxHeight);
            ctx.fillStyle = "#fff";
            lines.forEach((value, i) => ctx.fillText(value, width / 2, height - boxHeight - 78 + i * 58));
            ctx.restore();
          }

          onProgress?.((video.currentTime - candidate.start) / Math.max(0.01, candidate.end - candidate.start));
          requestAnimationFrame(draw);
        };
        draw();
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    video.currentTime = candidate.start;
  });

  await audioContext.close();
  stream.getTracks().forEach((track) => track.stop());
  const recorded = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
  if (recorded.type.includes("mp4")) return recorded;
  try {
    onProgress?.(0.97);
    return await toMp4(recorded);
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
