from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from openai_codex import Codex, Sandbox

SandboxName = Literal["read_only", "workspace_write"]


class ProjectPathError(ValueError):
    """Raised when the requested project directory is invalid."""


class CodexExecutionError(RuntimeError):
    """Raised when Codex cannot complete the requested turn."""


@dataclass(frozen=True)
class CodexRunResult:
    thread_id: str
    response: str


class CodexRunner:
    def run(
        self,
        project_path: str,
        prompt: str,
        sandbox_name: SandboxName,
    ) -> CodexRunResult:
        project = self._resolve_project(project_path)
        sandbox = self._sandbox(sandbox_name)

        try:
            with Codex() as codex:
                thread = codex.thread_start(cwd=str(project), sandbox=sandbox)
                result = thread.run(prompt, sandbox=sandbox)
        except Exception as exc:
            message = str(exc).strip() or type(exc).__name__
            raise CodexExecutionError(message) from exc

        return CodexRunResult(
            thread_id=str(thread.id),
            response=(result.final_response or "").strip(),
        )

    @staticmethod
    def _resolve_project(project_path: str) -> Path:
        try:
            project = Path(project_path).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ProjectPathError("项目目录不存在或无法访问。") from exc

        if not project.is_dir():
            raise ProjectPathError("项目路径必须指向一个目录。")
        return project

    @staticmethod
    def _sandbox(sandbox_name: SandboxName) -> Sandbox:
        if sandbox_name == "read_only":
            return Sandbox.read_only
        if sandbox_name == "workspace_write":
            return Sandbox.workspace_write
        raise ValueError(f"不支持的沙盒模式：{sandbox_name}")
