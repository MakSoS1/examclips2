import { useEffect, useMemo, useRef, useState } from "react";
import {
  BrainCircuit, Check, Cpu, Download, FileVideo2, Gauge, HardDrive, Play,
  RotateCcw, ShieldCheck, Sparkles, Upload, WandSparkles, X
} from "lucide-react";
import type { ClipCandidate, DeviceCapabilities, MediaInfo, PipelineProgress, Transcript } from "./types";
import {
  analyzeCandidateVisual, benchmarkDevice, buildLectureMap, extractAudio16k,
  generateCandidates, inspectMedia, saveProject, transcriptFromText
} from "./engine";
import { refineCandidatesWithMiniLLM, transcribeCloud, transcribeLocal } from "./ai";
import { downloadBlob, renderCandidate } from "./render";

type ASRMode = "local" | "cloud" | "manual";
const STAGES = ["probing", "audio", "transcribing", "mapping", "ranking", "visual", "review"];

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? [h, m, s].map((v) => String(v).padStart(2, "0")).join(":")
    : [m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function formatBytes(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return mb > 1024 ? (mb / 1024).toFixed(1) + " GB" : mb.toFixed(1) + " MB";
}

export default function App() {
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [asrMode, setAsrMode] = useState<ASRMode>("cloud");
  const [providerKey, setProviderKey] = useState("");
  const [language, setLanguage] = useState("ru");
  const [manualTranscript, setManualTranscript] = useState("");
  const [useMiniLLM, setUseMiniLLM] = useState(true);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [candidates, setCandidates] = useState<ClipCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<PipelineProgress>({ stage: "idle", progress: 0, message: "Выберите лекцию" });
  const [error, setError] = useState("");
  const [caption, setCaption] = useState("");
  const [dragging, setDragging] = useState(false);
  const previewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    benchmarkDevice().then(setCapabilities).catch(() => setCapabilities({
      webgpu: false,
      webcodecs: false,
      wasmThreads: false,
      cpuThreads: navigator.hardwareConcurrency || 2,
      memoryGB: null,
      tier: "LOW"
    }));
  }, []);

  useEffect(() => {
    return () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); };
  }, [sourceUrl]);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) || candidates[0] || null,
    [candidates, selectedId]
  );

  function chooseFile(next: File | null) {
    if (!next) return;
    if (!next.type.startsWith("video/") && !/\.(mp4|mov|mkv|webm|m4v)$/i.test(next.name)) {
      setError("Нужен видеофайл лекции.");
      return;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setSourceUrl(URL.createObjectURL(next));
    setFile(next);
    setMedia(null);
    setTranscript(null);
    setCandidates([]);
    setSelectedId(null);
    setError("");
    setProgress({ stage: "idle", progress: 0, message: "Видео готово к анализу" });
  }

  function setStage(stage: PipelineProgress["stage"], value: number, message: string) {
    setProgress({ stage, progress: Math.max(0, Math.min(1, value)), message });
  }

  async function runPipeline() {
    if (!file || !capabilities) return;
    setError("");
    try {
      setStage("probing", 0.08, "Читаю параметры лекции");
      const mediaInfo = await inspectMedia(file);
      setMedia(mediaInfo);

      let finalTranscript: Transcript;
      if (asrMode === "manual") {
        if (!manualTranscript.trim()) throw new Error("Вставьте транскрипт лекции.");
        setStage("transcribing", 0.55, "Подготавливаю импортированный транскрипт");
        finalTranscript = transcriptFromText(manualTranscript, mediaInfo.duration, language);
      } else {
        setStage("audio", 0.1, "Извлекаю только аудиодорожку — видео остаётся на устройстве");
        const audio = await extractAudio16k(file, (p) => setStage("audio", 0.1 + p * 0.25, "Готовлю аудио 16 kHz mono"));
        if (asrMode === "local") {
          finalTranscript = await transcribeLocal(audio, capabilities, language, (message) => setStage("transcribing", 0.42, message));
        } else {
          setStage("transcribing", 0.42, "Отправляю только аудиодорожку в ASR");
          finalTranscript = await transcribeCloud(audio, language, providerKey);
        }
      }

      if (!finalTranscript.segments.length) throw new Error("ASR не вернул распознанного текста.");
      setTranscript(finalTranscript);
      setStage("mapping", 0.63, "Строю карту лекции и смысловые окна");
      buildLectureMap(finalTranscript);

      let nextCandidates = generateCandidates(finalTranscript, 12);
      if (!nextCandidates.length) throw new Error("Не удалось найти самостоятельные фрагменты.");

      setStage("ranking", 0.72, "Ранжирую образовательные фрагменты");
      if (useMiniLLM) {
        nextCandidates = await refineCandidatesWithMiniLLM(
          finalTranscript,
          nextCandidates,
          capabilities,
          (message) => setStage("ranking", 0.76, message)
        );
      }

      const visualCount = Math.min(6, nextCandidates.length);
      const visualized = [...nextCandidates];
      for (let i = 0; i < visualCount; i++) {
        setStage("visual", 0.8 + 0.14 * ((i + 1) / visualCount), "Sparse visual analysis " + (i + 1) + "/" + visualCount);
        try {
          visualized[i] = {
            ...visualized[i],
            visual: await analyzeCandidateVisual(sourceUrl, visualized[i].start, visualized[i].end)
          };
        } catch {
          // Visual analysis is best-effort; the semantic clip stays usable.
        }
      }

      setCandidates(visualized);
      setSelectedId(visualized[0]?.id || null);
      await saveProject({
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^.]+$/, ""),
        media: mediaInfo,
        transcript: finalTranscript,
        candidates: visualized,
        updatedAt: new Date().toISOString()
      });
      setStage("review", 1, "Готово: выберите ролики перед финальным рендером");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Неизвестная ошибка";
      setError(message);
      setStage("error", 0, message);
    }
  }

  function toggleCandidate(id: string) {
    setCandidates((current) => current.map((candidate) =>
      candidate.id === id ? { ...candidate, accepted: !candidate.accepted } : candidate
    ));
  }

  function patchCandidate(id: string, patch: Partial<ClipCandidate>) {
    setCandidates((current) => current.map((candidate) =>
      candidate.id === id ? { ...candidate, ...patch } : candidate
    ));
  }

  function preview(candidate: ClipCandidate) {
    setSelectedId(candidate.id);
    const video = previewRef.current;
    if (!video) return;
    video.currentTime = candidate.start;
    video.play().catch(() => undefined);
  }

  function onPreviewTime() {
    const video = previewRef.current;
    if (!video || !selected || !transcript) return;
    if (video.currentTime > selected.end) {
      video.pause();
      video.currentTime = selected.start;
    }
    const active = transcript.segments.find((segment) =>
      video.currentTime >= segment.start && video.currentTime <= segment.end
    );
    setCaption(active?.text || "");
  }

  async function renderAccepted() {
    if (!transcript || !sourceUrl) return;
    const accepted = candidates.filter((candidate) => candidate.accepted);
    if (!accepted.length) {
      setError("Выберите хотя бы один клип.");
      return;
    }
    setError("");
    try {
      for (let i = 0; i < accepted.length; i++) {
        const candidate = accepted[i];
        setStage("rendering", i / accepted.length, "Рендерю " + (i + 1) + " из " + accepted.length + " локально");
        const blob = await renderCandidate(sourceUrl, candidate, transcript.segments, (local) =>
          setStage("rendering", (i + local) / accepted.length, "Рендерю " + (i + 1) + " из " + accepted.length)
        );
        const extension = blob.type.includes("mp4") ? "mp4" : "webm";
        downloadBlob(blob, "examclip-" + String(i + 1).padStart(2, "0") + "." + extension);
      }
      setStage("done", 1, "Все выбранные ролики сохранены");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Ошибка рендера";
      setError(message);
      setStage("error", 0, message);
    }
  }

  function reset() {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(null);
    setSourceUrl("");
    setMedia(null);
    setTranscript(null);
    setCandidates([]);
    setSelectedId(null);
    setManualTranscript("");
    setError("");
    setProgress({ stage: "idle", progress: 0, message: "Выберите лекцию" });
  }

  const currentStageIndex = Math.max(0, STAGES.indexOf(progress.stage));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={19} /></span>
          ExamClips Studio
        </div>
        <div className="row">
          <span className="badge"><ShieldCheck size={14} /> Local-first</span>
          {capabilities && <span className="badge"><Gauge size={14} /> {capabilities.tier}</span>}
        </div>
      </header>

      <main className="shell">
        {!candidates.length ? (
          <section className="hero">
            <div className="panel">
              <div className="eyebrow">Lecture → vertical shorts</div>
              <h1>Превращайте лекции в короткие видео без GPU-сервера</h1>
              <p className="muted">
                Исходное видео остаётся на устройстве. Сначала анализируется аудио и смысл,
                затем визуальная часть только лучших кандидатов, и только выбранные ролики рендерятся.
              </p>

              <div
                className={"dropzone" + (dragging ? " drag" : "")}
                onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
                onDragOver={(e) => e.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  chooseFile(e.dataTransfer.files[0] || null);
                }}
              >
                <div>
                  <FileVideo2 size={42} color="#8E82F1" />
                  <h2>{file ? file.name : "Перетащите запись лекции"}</h2>
                  <p className="muted">{file ? "Файл выбран. Он не загружается на VPS." : "MP4, MOV, MKV или WebM"}</p>
                  <label className="primary">
                    <Upload size={18} />
                    {file ? "Выбрать другое видео" : "Выбрать видео"}
                    <input hidden type="file" accept="video/*,.mkv" onChange={(event) => chooseFile(event.target.files?.[0] || null)} />
                  </label>
                </div>
              </div>

              {file && (
                <>
                  <div className="grid" style={{ marginTop: 16 }}>
                    <div className="stat"><strong>{formatBytes(file.size)}</strong><span className="muted">исходник локально</span></div>
                    <div className="stat"><strong>{capabilities?.webgpu ? "WebGPU" : "CPU/WASM"}</strong><span className="muted">локальный AI</span></div>
                    <div className="stat"><strong>{capabilities?.cpuThreads || "—"} потоков</strong><span className="muted">доступно браузеру</span></div>
                  </div>

                  <div style={{ marginTop: 20 }}>
                    <h2>Распознавание речи</h2>
                    <div className="row">
                      <button className={asrMode === "cloud" ? "primary" : "secondary"} onClick={() => setAsrMode("cloud")}>
                        <WandSparkles size={17} /> Free/BYOK cloud
                      </button>
                      <button className={asrMode === "local" ? "primary" : "secondary"} onClick={() => setAsrMode("local")}>
                        <Cpu size={17} /> Полностью локально
                      </button>
                      <button className={asrMode === "manual" ? "primary" : "secondary"} onClick={() => setAsrMode("manual")}>
                        <HardDrive size={17} /> Готовый транскрипт
                      </button>
                    </div>
                  </div>

                  {asrMode === "cloud" && (
                    <div className="grid" style={{ marginTop: 14 }}>
                      <label className="label" style={{ gridColumn: "span 2" }}>
                        Groq API key — необязательно, если ключ задан на VPS
                        <input className="input" type="password" value={providerKey} onChange={(e) => setProviderKey(e.target.value)} placeholder="gsk_..." autoComplete="off" />
                      </label>
                      <label className="label">
                        Язык
                        <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
                          <option value="ru">Русский</option>
                          <option value="en">English</option>
                          <option value="de">Deutsch</option>
                          <option value="auto">Auto</option>
                        </select>
                      </label>
                    </div>
                  )}

                  {asrMode === "manual" && (
                    <label className="label" style={{ marginTop: 14 }}>
                      Транскрипт — один смысловой абзац на строку
                      <textarea className="textarea" value={manualTranscript} onChange={(e) => setManualTranscript(e.target.value)} placeholder="Сегодня разберём производную..." />
                    </label>
                  )}

                  <label className="row" style={{ marginTop: 16, color: "#B3B9C6" }}>
                    <input type="checkbox" checked={useMiniLLM} onChange={(e) => setUseMiniLLM(e.target.checked)} />
                    <BrainCircuit size={16} />
                    Проверять top-кандидаты локальной mini-LLM на WebGPU, если устройство позволяет
                  </label>

                  <div style={{ marginTop: 18 }}>
                    <button className="primary" onClick={runPipeline} disabled={progress.stage !== "idle" && progress.stage !== "error"}>
                      <Sparkles size={18} /> Найти лучшие фрагменты
                    </button>
                  </div>
                </>
              )}

              {progress.stage !== "idle" && (
                <div style={{ marginTop: 22 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{progress.message}</strong>
                    <span className="muted">{Math.round(progress.progress * 100)}%</span>
                  </div>
                  <div className="progress" style={{ marginTop: 10 }}><div style={{ width: Math.round(progress.progress * 100) + "%" }} /></div>
                  <div className="pipeline">
                    {STAGES.map((stage, index) => (
                      <div key={stage} className={"step " + (index < currentStageIndex ? "done" : index === currentStageIndex ? "active" : "")} />
                    ))}
                  </div>
                </div>
              )}
              {error && <div className="panel error" style={{ marginTop: 16 }}>{error}</div>}
            </div>

            <aside className="panel">
              <h2>Что реально считается</h2>
              <div className="candidates">
                <div className="stat"><strong>1. Audio first</strong><span className="muted">Не отправляем гигабайты видео ради ASR.</span></div>
                <div className="stat"><strong>2. Text first</strong><span className="muted">Сначала смысловые кандидаты, затем CV.</span></div>
                <div className="stat"><strong>3. Sparse vision</strong><span className="muted">Кадры анализируются только внутри top-фрагментов.</span></div>
                <div className="stat"><strong>4. Render last</strong><span className="muted">Кодируем только то, что пользователь принял.</span></div>
              </div>
              <div className="panel success" style={{ marginTop: 16 }}>
                <strong>Privacy by architecture</strong>
                <p style={{ margin: "8px 0 0" }}>При cloud ASR уходит только аудио. В local-режиме лекция остаётся на устройстве.</p>
              </div>
            </aside>
          </section>
        ) : (
          <>
            <section className="panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="eyebrow">Candidate review</div>
                  <h2 style={{ marginBottom: 6 }}>Найдено {candidates.length} фрагментов</h2>
                  <span className="muted">{media ? formatDuration(media.duration) + " лекции · " + media.width + "×" + media.height : ""}</span>
                </div>
                <div className="row">
                  <button className="secondary" onClick={reset}><RotateCcw size={16} /> Другая лекция</button>
                  <button className="primary" onClick={renderAccepted} disabled={progress.stage === "rendering"}>
                    <Download size={17} /> Рендерить выбранные
                  </button>
                </div>
              </div>
              {(progress.stage === "rendering" || progress.stage === "done") && (
                <div style={{ marginTop: 16 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}><span>{progress.message}</span><span className="muted">{Math.round(progress.progress * 100)}%</span></div>
                  <div className="progress" style={{ marginTop: 8 }}><div style={{ width: Math.round(progress.progress * 100) + "%" }} /></div>
                </div>
              )}
              {error && <div className="panel error" style={{ marginTop: 14 }}>{error}</div>}
            </section>

            <section className="workspace">
              <div className="candidates">
                {candidates.map((candidate) => (
                  <article className={"clip" + (candidate.accepted ? " accepted" : "")} key={candidate.id}>
                    <div className="score">{Math.round(candidate.score * 100)}%</div>
                    <div>
                      <div className="clip-title">{candidate.title}</div>
                      <div className="clip-meta">
                        {formatDuration(candidate.start)}–{formatDuration(candidate.end)} · {Math.round(candidate.end - candidate.start)} сек · {candidate.visual?.faceDetected ? "speaker detected" : "slide/center layout"}
                      </div>
                      <div className="muted" style={{ fontSize: 13, marginTop: 5 }}>{candidate.reason}</div>
                      <div className="row" style={{ marginTop: 10 }}>
                        <label className="label">Start
                          <input className="input" style={{ width: 100 }} type="number" min={0} step={0.1} value={candidate.start.toFixed(1)} onChange={(e) => patchCandidate(candidate.id, { start: Number(e.target.value) })} />
                        </label>
                        <label className="label">End
                          <input className="input" style={{ width: 100 }} type="number" min={candidate.start + 1} step={0.1} value={candidate.end.toFixed(1)} onChange={(e) => patchCandidate(candidate.id, { end: Number(e.target.value) })} />
                        </label>
                      </div>
                    </div>
                    <div className="row">
                      <button className="secondary" onClick={() => preview(candidate)}><Play size={16} /> Preview</button>
                      <button className={candidate.accepted ? "primary" : "ghost"} onClick={() => toggleCandidate(candidate.id)}>
                        {candidate.accepted ? <Check size={16} /> : <X size={16} />}
                        {candidate.accepted ? "Выбран" : "Пропустить"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              <aside className="phone-wrap">
                <div className="panel">
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
                    <strong>Live preview</strong>
                    <span className="badge">{selected ? Math.round(selected.end - selected.start) + " sec" : "—"}</span>
                  </div>
                  <div className="phone">
                    {sourceUrl && (
                      <video
                        ref={previewRef}
                        src={sourceUrl}
                        controls
                        playsInline
                        onTimeUpdate={onPreviewTime}
                        onLoadedMetadata={() => { if (selected && previewRef.current) previewRef.current.currentTime = selected.start; }}
                        style={{ objectPosition: selected?.visual?.faceDetected ? Math.round(selected.visual.faceX * 100) + "% center" : "center center" }}
                      />
                    )}
                    {caption && <div className="caption">{caption}</div>}
                  </div>
                  {selected && (
                    <div style={{ marginTop: 14 }}>
                      <strong>{selected.title}</strong>
                      <p className="muted" style={{ fontSize: 13, marginTop: 7 }}>
                        Visual dependency: {Math.round(selected.visualDependency * 100)}%. Финальный экспорт делает crop и субтитры локально.
                      </p>
                    </div>
                  )}
                </div>
              </aside>
            </section>
          </>
        )}
        <div className="footer-note">ExamClips2 MVP · видео по умолчанию не хранится на сервере</div>
      </main>
    </div>
  );
}
