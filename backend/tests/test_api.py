from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_project_roundtrip():
    created = client.post(
        "/api/v1/projects",
        json={"name": "Demo lecture", "media": {"duration": 90}},
    )
    assert created.status_code == 200
    project_id = created.json()["id"]

    state = client.post(
        f"/api/v1/projects/{project_id}/state",
        json={"state": {"stage": "review", "candidate_count": 6}},
    )
    assert state.status_code == 200
    assert state.json()["state"]["stage"] == "review"

    fetched = client.get(f"/api/v1/projects/{project_id}")
    assert fetched.status_code == 200
    assert fetched.json()["media"]["duration"] == 90
