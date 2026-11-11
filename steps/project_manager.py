"""Project management system for Form 3D Studio.

Each project is stored in an isolated folder (`project_0001`, `project_0002`, ...)
containing `project.json` and all generated 2D/3D artifacts (sheet, tiles, glb, stl).
"""

from __future__ import annotations

import datetime
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from steps.step1_optimize_prompt import REPO_ROOT, sanitize_slug

PROJECT_ID_PATTERN = re.compile(r"^project_(\d{4})$")


def get_projects_root_dir() -> Path:
    """Resolve the root projects storage directory.

    Order of priority:
    1. Environment variable `3DGENERATOR_PROJECTS_DIR`
    2. macOS standard: `~/Library/Application Support/3DGenerator/projects`
    3. Fallback: `<repo_root>/projects`
    """
    env_dir = os.environ.get("3DGENERATOR_PROJECTS_DIR")
    if env_dir:
        p = Path(env_dir).expanduser().resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    app_support = Path.home() / "Library" / "Application Support" / "3DGenerator" / "projects"
    try:
        app_support.mkdir(parents=True, exist_ok=True)
        return app_support.resolve()
    except Exception:
        fallback = (REPO_ROOT / "projects").resolve()
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def get_next_project_id(projects_dir: Path | None = None) -> str:
    """Scan existing directories and return the next formatted `project_XXXX` ID."""
    root = projects_dir or get_projects_root_dir()
    max_num = 0
    if root.is_dir():
        for entry in root.iterdir():
            if entry.is_dir():
                match = PROJECT_ID_PATTERN.match(entry.name)
                if match:
                    max_num = max(max_num, int(match.group(1)))
    next_num = max_num + 1
    return f"project_{next_num:04d}"


def read_project_meta(project_dir: Path) -> dict[str, Any] | None:
    """Read `project.json` from a project folder."""
    meta_path = project_dir / "project.json"
    if not meta_path.is_file():
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else None
    except Exception:
        return None


def write_project_meta(project_dir: Path, meta: dict[str, Any]) -> None:
    """Write or update `project.json` in a project folder."""
    project_dir.mkdir(parents=True, exist_ok=True)
    meta_path = project_dir / "project.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)


def create_project(
    prompt: str,
    name: str | None = None,
    settings: dict[str, Any] | None = None,
    projects_dir: Path | None = None,
) -> dict[str, Any]:
    """Create a new project folder `project_XXXX` with initial `project.json`."""
    root = projects_dir or get_projects_root_dir()
    proj_id = get_next_project_id(root)
    proj_dir = root / proj_id
    proj_dir.mkdir(parents=True, exist_ok=True)

    # Derive default name if not provided
    if not name or not name.strip():
        cleaned_prompt = prompt.strip()
        for prefix in ("Generate a ", "generate a ", "Generate an ", "generate an ", "Generate ", "generate "):
            if cleaned_prompt.startswith(prefix):
                cleaned_prompt = cleaned_prompt[len(prefix) :]
                break
        name = cleaned_prompt[:40].strip().title() or f"Project {proj_id[-4:]}"

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    meta: dict[str, Any] = {
        "id": proj_id,
        "name": name,
        "prompt": prompt,
        "created_at": now_iso,
        "updated_at": now_iso,
        "stage": "idle",
        "completed_steps": [],
        "settings": settings or {"target_height_mm": 80, "device": "mps"},
    }
    write_project_meta(proj_dir, meta)
    return meta


def rename_project(
    project_id: str,
    new_name: str,
    projects_dir: Path | None = None,
) -> dict[str, Any] | None:
    """Rename a project by updating its `project.json`."""
    root = projects_dir or get_projects_root_dir()
    proj_dir = root / project_id
    if not proj_dir.is_dir():
        return None

    meta = read_project_meta(proj_dir)
    if meta is None:
        meta = {
            "id": project_id,
            "name": new_name.strip(),
            "prompt": new_name,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "stage": "complete",
            "completed_steps": [1, 2, 3, 4, 5],
        }

    meta["name"] = new_name.strip()
    meta["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_project_meta(proj_dir, meta)
    return meta


def delete_project(project_id: str, projects_dir: Path | None = None) -> bool:
    """Delete a project folder."""
    root = projects_dir or get_projects_root_dir()
    proj_dir = root / project_id
    if proj_dir.is_dir():
        shutil.rmtree(proj_dir, ignore_errors=True)
        return True
    return False


def list_projects(projects_dir: Path | None = None) -> list[dict[str, Any]]:
    """List all projects sorted by `updated_at` descending."""
    root = projects_dir or get_projects_root_dir()
    results: list[dict[str, Any]] = []
    if not root.is_dir():
        return results

    for entry in root.iterdir():
        if entry.is_dir():
            match = PROJECT_ID_PATTERN.match(entry.name)
            if match:
                meta = read_project_meta(entry)
                if meta:
                    # Look for 3D model preview or GLB file
                    preview_png = entry / f"{sanitize_slug(meta.get('name', ''))}_mesh_preview.png"
                    if not preview_png.is_file():
                        # Try any *_mesh_preview.png
                        previews = list(entry.glob("*_mesh_preview.png"))
                        preview_file = previews[0].name if previews else None
                    else:
                        preview_file = preview_png.name

                    glb_files = list(entry.glob("*.glb"))
                    stl_files = list(entry.glob("*.stl"))

                    results.append(
                        {
                            "id": meta["id"],
                            "name": meta.get("name", entry.name),
                            "prompt": meta.get("prompt", ""),
                            "created_at": meta.get("created_at"),
                            "updated_at": meta.get("updated_at") or meta.get("created_at"),
                            "stage": meta.get("stage", "idle"),
                            "completed_steps": meta.get("completed_steps", []),
                            "has_3d_model": bool(glb_files or stl_files),
                            "preview_url": f"/projects/{entry.name}/{preview_file}" if preview_file else None,
                        }
                    )

    # Sort newest first
    results.sort(
        key=lambda p: p.get("updated_at") or p.get("created_at") or "",
        reverse=True,
    )
    return results
