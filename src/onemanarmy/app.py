from __future__ import annotations

from pathlib import Path
from typing import Literal, Protocol

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .codex_client import (
    CodexExecutionError,
    CodexRunner,
    CodexRunResult,
    ProjectPathError,
)

STATIC_DIR = Path(__file__).parent / "static"


class Runner(Protocol):
    def run(
        self,
        project_path: str,
        prompt: str,
        sandbox_name: Literal["read_only", "workspace_write"],
    ) -> CodexRunResult: ...


class RunRequest(BaseModel):
    project_path: str = Field(min_length=1, max_length=4096)
    prompt: str = Field(min_length=1, max_length=20000)
    sandbox: Literal["read_only", "workspace_write"] = "read_only"

    @field_validator("project_path", "prompt")
    @classmethod
    def reject_blank_values(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("内容不能为空。")
        return value


class RunResponse(BaseModel):
    thread_id: str
    response: str


def create_app(
    runner: Runner | None = None,
    default_project_path: str | Path | None = None,
) -> FastAPI:
    app = FastAPI(title="OneManArmy", version="0.1.0")
    app.state.runner = runner or CodexRunner()
    app.state.default_project_path = str(
        Path(default_project_path or Path.cwd()).resolve()
    )

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/config")
    async def config() -> dict[str, str]:
        return {"default_project_path": app.state.default_project_path}

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/runs", response_model=RunResponse)
    async def run_codex(request: RunRequest) -> RunResponse:
        try:
            result = await run_in_threadpool(
                app.state.runner.run,
                request.project_path,
                request.prompt,
                request.sandbox,
            )
        except ProjectPathError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except CodexExecutionError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Codex 调用失败：{exc}",
            ) from exc

        return RunResponse(thread_id=result.thread_id, response=result.response)

    return app
