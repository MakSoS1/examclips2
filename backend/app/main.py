import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./examclips2.db")
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)


class Base(DeclarativeBase):
    pass


class ProjectRow(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    media_json: Mapped[str] = mapped_column(Text, default="{}")
    state_json: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


Base.metadata.create_all(engine)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    media: dict[str, Any] = Field(default_factory=dict)


class ProjectState(BaseModel):
    state: dict[str, Any] = Field(default_factory=dict)


def serialize_project(row: ProjectRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "media": json.loads(row.media_json or "{}"),
        "state": json.loads(row.state_json or "{}"),
        "updated_at": row.updated_at.isoformat(),
    }


app = FastAPI(title="ExamClips2 API", version="0.1.0")
origins = [v.strip() for v in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if v.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/projects")
def create_project(payload: ProjectCreate) -> dict[str, Any]:
    project = ProjectRow(
        id="prj_" + uuid.uuid4().hex,
        name=payload.name,
        media_json=json.dumps(payload.media, ensure_ascii=False),
        state_json="{}",
        updated_at=datetime.now(timezone.utc),
    )
    with Session(engine) as session:
        session.add(project)
        session.commit()
        session.refresh(project)
        return serialize_project(project)


@app.get("/api/v1/projects/{project_id}")
def get_project(project_id: str) -> dict[str, Any]:
    with Session(engine) as session:
        project = session.get(ProjectRow, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        return serialize_project(project)


@app.post("/api/v1/projects/{project_id}/state")
def update_state(project_id: str, payload: ProjectState) -> dict[str, Any]:
    with Session(engine) as session:
        project = session.get(ProjectRow, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        project.state_json = json.dumps(payload.state, ensure_ascii=False)
        project.updated_at = datetime.now(timezone.utc)
        session.commit()
        session.refresh(project)
        return serialize_project(project)


@app.post("/api/asr/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("ru"),
    x_provider_key: str | None = Header(default=None, alias="X-Provider-Key"),
) -> dict[str, Any]:
    api_key = (x_provider_key or os.getenv("GROQ_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(
            503,
            "Groq key is not configured. Add GROQ_API_KEY on VPS, enter your own key, or use Local ASR.",
        )

    audio = await file.read()
    if len(audio) > 25 * 1024 * 1024:
        raise HTTPException(413, "Audio payload is larger than 25 MB. Use Local ASR or a shorter recording.")

    data = {"model": "whisper-large-v3-turbo", "response_format": "verbose_json"}
    if language and language != "auto":
        data["language"] = language

    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": "Bearer " + api_key},
            data=data,
            files={"file": (file.filename or "lecture.wav", audio, file.content_type or "audio/wav")},
        )

    if response.status_code >= 400:
        raise HTTPException(response.status_code, "ASR provider error: " + response.text[:1000])

    payload = response.json()
    raw_segments = payload.get("segments") or []
    segments = []
    for index, segment in enumerate(raw_segments):
        text = str(segment.get("text") or "").strip()
        if text:
            segments.append(
                {
                    "id": "cloud-" + str(index),
                    "start": float(segment.get("start") or 0),
                    "end": float(segment.get("end") or segment.get("start") or 0),
                    "text": text,
                }
            )

    duration = float(payload.get("duration") or 0)
    if not segments and payload.get("text"):
        segments = [{"id": "cloud-0", "start": 0, "end": duration, "text": str(payload["text"]).strip()}]

    return {
        "language": str(payload.get("language") or language or "unknown"),
        "duration": duration,
        "segments": segments,
    }
