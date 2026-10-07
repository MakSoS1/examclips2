import { describe, expect, it } from "vitest";
import { buildLectureMap, generateCandidates, transcriptFromText } from "./engine";

describe("lecture engine", () => {
  it("creates deterministic timed segments from manual transcript", () => {
    const transcript = transcriptFromText("Первая тема\nВторая тема\nТретья тема", 90);
    expect(transcript.segments).toHaveLength(3);
    expect(transcript.segments[1].start).toBe(30);
    expect(transcript.segments[2].end).toBe(90);
  });

  it("builds a lecture map and candidates", () => {
    const paragraphs = Array.from({ length: 18 }, (_, i) =>
      i % 3 === 0
        ? "Важно понимать почему этот метод работает. Рассмотрим пример и получим полезный вывод для задачи."
        : "Продолжаем объяснение темы с деталями, вычислениями и последовательным выводом результата."
    );
    const transcript = transcriptFromText(paragraphs.join("\n"), 540);
    const map = buildLectureMap(transcript);
    const candidates = generateCandidates(transcript, 8);
    expect(map.length).toBeGreaterThan(0);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].score).toBeGreaterThan(0.45);
  });
});
