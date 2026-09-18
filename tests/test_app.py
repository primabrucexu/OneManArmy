from pathlib import Path

from fastapi.testclient import TestClient

from onemanarmy.app import create_app
from onemanarmy.codex_client import CodexRunResult


class FakeRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def run(self, project_path: str, prompt: str, sandbox_name: str) -> CodexRunResult:
        self.calls.append((project_path, prompt, sandbox_name))
        return CodexRunResult(thread_id="thread-demo", response="Demo response")


def test_index_and_config(tmp_path: Path) -> None:
    client = TestClient(create_app(FakeRunner(), default_project_path=tmp_path))

    page = client.get("/")
    config = client.get("/api/config")

    assert page.status_code == 200
    assert "OneManArmy" in page.text
    assert config.json() == {"default_project_path": str(tmp_path.resolve())}


def test_run_invokes_runner(tmp_path: Path) -> None:
    runner = FakeRunner()
    client = TestClient(create_app(runner, default_project_path=tmp_path))

    response = client.post(
        "/api/runs",
        json={
            "project_path": str(tmp_path),
            "prompt": "Inspect this project",
            "sandbox": "read_only",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "thread_id": "thread-demo",
        "response": "Demo response",
    }
    assert runner.calls == [(str(tmp_path), "Inspect this project", "read_only")]


def test_run_rejects_blank_prompt(tmp_path: Path) -> None:
    client = TestClient(create_app(FakeRunner(), default_project_path=tmp_path))

    response = client.post(
        "/api/runs",
        json={
            "project_path": str(tmp_path),
            "prompt": "   ",
            "sandbox": "read_only",
        },
    )

    assert response.status_code == 422
