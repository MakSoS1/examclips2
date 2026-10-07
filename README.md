# ExamClips2

Local-first MVP для автоматического преобразования длинных учебных лекций в короткие вертикальные образовательные видео.

## Реализовано

- Исходное видео по умолчанию остаётся на устройстве.
- Browser capability benchmark: WebGPU, WebCodecs, CPU threads и device tier.
- Извлечение и ресэмплинг аудио в 16 kHz mono.
- Cloud/BYOK ASR через тонкий FastAPI proxy.
- Полностью локальный Whisper через Transformers.js.
- Импорт готового транскрипта как надёжный fallback.
- Lecture Map и deterministic candidate generation.
- Heuristic ranking и фильтрация плохих границ.
- Optional локальная Qwen2.5 0.5B mini-LLM на WebGPU для проверки top-кандидатов.
- Sparse visual analysis только внутри лучших временных интервалов.
- Optional FaceDetector и scene-change detection.
- Вертикальный live preview с субтитрами.
- Ручная коррекция start/end и accept/reject.
- Локальный render только выбранных фрагментов.
- MP4 transcoding через ffmpeg.wasm с WebM fallback.
- IndexedDB project state.
- FastAPI plus SQLAlchemy control-plane.
- PostgreSQL production и SQLite local fallback.
- Docker Compose для VPS.
- GitHub Actions CI.

## Pipeline

    video
      -> audio only
      -> ASR
      -> lecture map
      -> candidate generation
      -> mini-LLM only for top candidates
      -> sparse vision only for top candidates
      -> live preview
      -> user accepts clips
      -> render only accepted clips

Главное правило: дорогая операция запускается только после дешёвого фильтра.

## Local development

Frontend:

    npm install
    npm run dev

API:

    cd backend
    python -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn app.main:app --reload

Vite проксирует /api на http://127.0.0.1:8000.

## VPS

    cp .env.example .env
    docker compose up -d --build

После запуска web доступен на порту 80.

## ASR

Cloud mode использует whisper-large-v3-turbo через Groq-compatible endpoint. Можно задать GROQ_API_KEY на VPS либо передать собственный ключ только для текущего запроса. Ключ из UI не сохраняется в БД.

Local mode использует Transformers.js. В зависимости от device tier выбирается Whisper small, base или tiny. Модель загружается в браузер при первом использовании.

## Mini-LLM

На WebGPU устройствах top-кандидаты дополнительно проверяются локальной Qwen2.5-0.5B-Instruct. При любой ошибке pipeline сохраняет deterministic heuristic ranking, поэтому mini-LLM не является single point of failure.

## Privacy

- VPS не получает исходное видео.
- Local ASR не отправляет аудио.
- Cloud ASR получает только аудио.
- Visual analysis локальный.
- Final render локальный.
- Provider key не пишется в database.

## MVP limitations and next optimization

Текущая browser audio preparation использует AudioContext.decodeAudioData. Для очень длинных файлов это может потреблять заметную RAM. Следующий performance milestone: streaming demux/audio decode, чтобы не держать полную декодированную дорожку в памяти.

FaceDetector optional. Если API отсутствует, работает center/slide fallback.

MP4 conversion загружает ffmpeg core при первом экспорте. При недоступности transcoding результат сохраняется WebM, чтобы не потерять обработанный ролик.

GitHub Actions применяется только как CI/CD и validation VM, не как production inference backend.
