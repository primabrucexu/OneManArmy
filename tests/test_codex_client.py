from pathlib import Path

import pytest

from onemanarmy.codex_client import CodexRunner, ProjectPathError


def test_runner_rejects_missing_project(tmp_path: Path) -> None:
    missing = tmp_path / "missing"

    with pytest.raises(ProjectPathError, match="不存在"):
        CodexRunner().run(str(missing), "Inspect the project", "read_only")


def test_runner_rejects_file_as_project(tmp_path: Path) -> None:
    file_path = tmp_path / "not-a-directory.txt"
    file_path.write_text("demo", encoding="utf-8")

    with pytest.raises(ProjectPathError, match="目录"):
        CodexRunner().run(str(file_path), "Inspect the project", "read_only")
