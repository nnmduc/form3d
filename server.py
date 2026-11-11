#!/usr/bin/env python3
"""FastAPI + Server-Sent Events (SSE) bridge for the 5-step Text-to-3D Studio UI."""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import mimetypes
import os
import sys
import types
from pathlib import Path
from typing import Any, AsyncGenerator, Literal

# Ensure pymeshlab is available in sys.modules so hy3dgen.shapegen does not fail on import
if "pymeshlab" not in sys.modules:
    try:
        import pymeshlab
    except ImportError:
        _dummy = types.ModuleType("pymeshlab")
        class _DummyMeshSet:
            def __init__(self, *a: Any, **k: Any) -> None: pass
            def load_new_mesh(self, *a: Any, **k: Any) -> None: pass
            def current_mesh(self) -> Any: return self
            def face_number(self) -> int: return 0
            def add_mesh(self, *a: Any, **k: Any) -> None: pass
            def meshing_decimation_quadric_edge_collapse(self, *a: Any, **k: Any) -> None: pass
        class _DummyMesh:
            def __init__(self, *a: Any, **k: Any) -> None: pass
        _dummy.MeshSet = _DummyMeshSet
        _dummy.Mesh = _DummyMesh
        _dummy.PercentageValue = lambda x: x
        sys.modules["pymeshlab"] = _dummy

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from steps.agy_runner import check_agy_status, find_agy_binary, load_app_config, save_app_config
from steps.model_manager import check_models_status, stream_download_models
from steps.project_manager import (
    create_project,
    delete_project,
    get_projects_root_dir,
    list_projects,
    read_project_meta,
    rename_project,
    write_project_meta,
)
from steps.step1_optimize_prompt import REPO_ROOT, run_step1, sanitize_slug
from steps.step2_generate_image import run_step2
from steps.step3_process_image import run_step3
from steps.step4_optimize_3d import run_step4
from steps.step5_generate_mesh import (
    normalize_remote_url,
    probe_remote_worker_health,
    run_step5,
    select_compute_device,
)

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/stl", ".stl")

OUTPUTS_DIR = (REPO_ROOT / "outputs").resolve()
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
PROJECTS_DIR = get_projects_root_dir()

LOG_DIR = Path.home() / "Library" / "Logs" / "Form 3D"
try:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    LOG_FILE = LOG_DIR / "server.log"
except Exception:
    LOG_FILE = PROJECTS_DIR.parent / "server.log"

logger = logging.getLogger("form3d")
logger.setLevel(logging.INFO)
file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
file_handler.setLevel(logging.INFO)
file_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
file_handler.setFormatter(file_formatter)
logger.addHandler(file_handler)
logger.addHandler(logging.StreamHandler(sys.stdout))
logger.propagate = True

DEFAULT_TILE_ORDER: list[tuple[str, str, str, str]] = [
    ("front", "Front", "0°", "tile_tl"),
    ("left", "Left", "90°", "tile_tr"),
    ("back", "Back", "180°", "tile_bl"),
    ("right", "Right", "270°", "tile_br"),
]


class GenerateRequest(BaseModel):
    """Request payload for `POST /api/generate`."""

    prompt: str = Field(default="Generate a cute robot", min_length=1)
    mode: Literal["auto", "live", "replay"] = Field(default="auto")
    from_step: int = Field(default=1, ge=1, le=5)
    to_step: int = Field(default=5, ge=1, le=5)
    asset_name: str | None = Field(default=None)
    device: str | None = Field(default=None)
    project_id: str | None = Field(default=None)
    remote_url: str | None = Field(default=None)


class ColabProbeRequest(BaseModel):
    """Request payload for probing or configuring the remote Google Colab GPU worker URL."""

    url: str = Field(default="")
    save: bool = Field(default=True)


class RenameProjectRequest(BaseModel):
    """Request payload for renaming a project."""

    name: str = Field(min_length=1, max_length=100)


class CreateProjectRequest(BaseModel):
    """Request payload for creating a new project."""

    prompt: str = Field(min_length=1)
    name: str | None = Field(default=None)


class SetAgyPathRequest(BaseModel):
    """Request payload for updating the agy binary path."""

    path: str = Field(min_length=1)


def _read_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def resolve_existing_asset_dir(prompt: str, explicit_asset_name: str | None = None) -> Path | None:
    """Resolve an existing `outputs/<slug>` directory from an asset name or prompt if present."""
    if explicit_asset_name:
        slug = sanitize_slug(explicit_asset_name)
        candidate = OUTPUTS_DIR / slug
        if candidate.is_dir():
            return candidate

    cleaned = prompt.strip()
    for prefix in ("Generate a ", "generate a ", "Generate an ", "generate an ", "Generate ", "generate "):
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix) :]
            break

    slug = sanitize_slug(cleaned)
    candidate = OUTPUTS_DIR / slug
    if candidate.is_dir():
        return candidate

    raw_slug = sanitize_slug(prompt)
    raw_candidate = OUTPUTS_DIR / raw_slug
    if raw_candidate.is_dir():
        return raw_candidate

    return None


def resolve_base_url(asset_dir: Path) -> str:
    """Determine whether the asset is served from /projects/ or /outputs/."""
    asset_dir = asset_dir.resolve()
    if asset_dir.name.startswith("project_") or (asset_dir.parent == PROJECTS_DIR):
        return f"/projects/{asset_dir.name}"
    return f"/outputs/{asset_dir.name}"


def build_asset_payload(asset_dir: Path) -> dict[str, Any]:
    """Serialize all completed step artifacts in `projects/<id>` or `outputs/<slug>` for the Studio UI."""
    asset_dir = asset_dir.resolve()
    slug = asset_dir.name
    base_url = resolve_base_url(asset_dir)

    project_meta = _read_json_if_exists(asset_dir / "project.json")
    step1 = _read_json_if_exists(asset_dir / "step1_prompt.json")
    step2 = _read_json_if_exists(asset_dir / "step2_image.json")
    step3 = _read_json_if_exists(asset_dir / "step3_tiles.json")
    step4 = _read_json_if_exists(asset_dir / "step4_3d_config.json")
    manifest = _read_json_if_exists(asset_dir / "manifest.json")

    asset_name = (
        (step1 or {}).get("asset_name")
        or (manifest or {}).get("asset_name")
        or (project_meta or {}).get("name")
        or slug
    )
    sheet_file = asset_dir / "sheet.png"
    glb_file = asset_dir / f"{asset_name}.glb"
    if not glb_file.is_file():
        glb_file = asset_dir / f"{slug}.glb"
    stl_file = asset_dir / f"{asset_name}.stl"
    if not stl_file.is_file():
        stl_file = asset_dir / f"{slug}.stl"
    preview_file = asset_dir / f"{asset_name}_mesh_preview.png"
    if not preview_file.is_file():
        preview_file = asset_dir / f"{slug}_mesh_preview.png"

    completed_steps: list[int] = []
    if step1 is not None:
        completed_steps.append(1)
    if step2 is not None or sheet_file.is_file():
        completed_steps.append(2)
    if step3 is not None or (asset_dir / "tiles" / "tile_tl.png").is_file():
        completed_steps.append(3)
    if step4 is not None:
        completed_steps.append(4)
    if manifest is not None and (glb_file.is_file() or stl_file.is_file()):
        completed_steps.append(5)

    if 5 in completed_steps:
        stage = "complete"
    elif 4 in completed_steps:
        stage = "reconstructing"
    elif 3 in completed_steps:
        stage = "slicing"
    elif 2 in completed_steps:
        stage = "turnaround"
    elif 1 in completed_steps:
        stage = "optimizing"
    else:
        stage = "idle"

    step3_tiles_meta = (step3 or {}).get("tiles", {})
    step4_view_mapping = (step4 or {}).get("view_mapping", {})

    tiles_list: list[dict[str, Any]] = []
    for view_id, label, angle, default_tile_key in DEFAULT_TILE_ORDER:
        mapped_path_str = step4_view_mapping.get(view_id)
        tile_key = default_tile_key
        if mapped_path_str:
            mapped_name = Path(mapped_path_str).stem
            if mapped_name in ("tile_tl", "tile_tr", "tile_bl", "tile_br"):
                tile_key = mapped_name

        tile_meta = step3_tiles_meta.get(tile_key, {})
        tile_file = asset_dir / "tiles" / f"{tile_key}.png"
        tile_url = f"{base_url}/tiles/{tile_key}.png" if tile_file.is_file() else None

        tiles_list.append(
            {
                "id": view_id,
                "label": label,
                "angle": angle,
                "tile_key": tile_key,
                "src": tile_url,
                "coverage_ratio": tile_meta.get("coverage_ratio"),
                "components_kept": tile_meta.get("components_kept"),
                "components_total": tile_meta.get("components_total"),
                "verified": view_id in step4_view_mapping,
            }
        )

    return {
        "asset_name": asset_name,
        "slug": slug,
        "stage": stage,
        "completed_steps": completed_steps,
        "project_id": (project_meta or {}).get("id") or (slug if slug.startswith("project_") else None),
        "project_name": (project_meta or {}).get("name") or asset_name,
        "urls": {
            "sheet": f"{base_url}/sheet.png" if sheet_file.is_file() else None,
            "glb": f"{base_url}/{glb_file.name}" if glb_file.is_file() else None,
            "stl": f"{base_url}/{stl_file.name}" if stl_file.is_file() else None,
            "mesh_preview": f"{base_url}/{preview_file.name}" if preview_file.is_file() else None,
        },
        "tiles": tiles_list,
        "step1": step1,
        "step2": step2,
        "step3": step3,
        "step4": step4,
        "manifest": manifest,
    }


def _sse_event(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def stream_replay_pipeline(asset_dir: Path) -> AsyncGenerator[str, None]:
    """Stream a paced 5-step studio progression from an existing completed asset directory."""
    payload = build_asset_payload(asset_dir)

    # Step 1: Optimizing Spec
    yield _sse_event(
        "stage",
        {
            "stage": "optimizing",
            "step": 1,
            "status": "running",
            "message": "Refining spatial specification",
            "progress": 15,
            "asset": payload,
            "mode": "replay",
        },
    )
    await asyncio.sleep(3.2)
    yield _sse_event(
        "step_complete",
        {
            "stage": "optimizing",
            "step": 1,
            "status": "done",
            "message": "Spatial specification ready",
            "progress": 25,
            "asset": payload,
            "mode": "replay",
        },
    )
    await asyncio.sleep(2.4)

    # Step 2: 2x2 Turnaround Sheet
    yield _sse_event(
        "stage",
        {
            "stage": "turnaround",
            "step": 2,
            "status": "running",
            "message": "Synthesizing orthographic sheet",
            "progress": 42,
            "asset": payload,
            "mode": "replay",
        },
    )
    await asyncio.sleep(3.5)
    yield _sse_event(
        "step_complete",
        {
            "stage": "turnaround",
            "step": 2,
            "status": "done",
            "message": "Orthographic sheet generated",
            "progress": 55,
            "asset": payload,
            "mode": "replay",
        },
    )
    await asyncio.sleep(2.4)

    # Step 3: 4 Sliced RGBA Views
    yield _sse_event(
        "stage",
        {
            "stage": "slicing",
            "step": 3,
            "status": "running",
            "message": "Isolating four views",
            "progress": 68,
            "asset": payload,
            "mode": "replay",
        },
    )
    await asyncio.sleep(3.2)
    yield _sse_event(
        "step_complete",
        {
            "stage": "slicing",
            "step": 3,
            "status": "done",
            "message": "Four RGBA views isolated",
            "progress": 76,
            "asset": payload,
            "mode": "replay",
        },
    )
    await asyncio.sleep(2.4)

    # Step 4 & 5: View Verification + Reconstructing Watertight Mesh
    yield _sse_event(
        "stage",
        {
            "stage": "reconstructing",
            "step": 4,
            "status": "running",
            "message": "Verifying views and 3D parameters",
            "progress": 84,
            "asset": payload,
            "mode": "replay",
        },
    )
    await asyncio.sleep(2.2)
    yield _sse_event(
        "stage",
        {
            "stage": "reconstructing",
            "step": 5,
            "status": "running",
            "message": "Reconstructing watertight mesh",
            "progress": 94,
            "asset": payload,
            "mode": "replay",
        },
    )
    await asyncio.sleep(3.8)

    yield _sse_event(
        "complete",
        {
            "stage": "complete",
            "step": 5,
            "status": "complete",
            "message": f"{int((payload.get('manifest') or {}).get('target_height_mm', 80))} mm watertight solid",
            "progress": 100,
            "asset": payload,
            "mode": "replay",
        },
    )


def sync_project_meta_step(output_dir: Path, stage: str, step: int) -> None:
    """Update `project.json` inside output_dir if present with completed step."""
    meta = read_project_meta(output_dir)
    if meta:
        steps = list(meta.get("completed_steps", []))
        if step not in steps:
            steps.append(step)
        meta["completed_steps"] = sorted(steps)
        meta["stage"] = stage
        meta["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_project_meta(output_dir, meta)


class PipelineJob:
    """Represents an independent, background 3D generation job decoupled from HTTP SSE client connections."""

    def __init__(self, project_id: str, output_dir: Path, req: GenerateRequest):
        self.project_id = project_id
        self.output_dir = output_dir
        self.req = req
        self.subscribers: set[asyncio.Queue] = set()
        self.history: list[tuple[str, dict[str, Any]]] = []
        self.is_done: bool = False
        self.error: str | None = None
        self.task: asyncio.Task | None = None

    def broadcast(self, event_type: str, data: dict[str, Any]) -> None:
        self.history.append((event_type, data))
        if len(self.history) > 60:
            self.history.pop(0)
        dead = []
        for q in list(self.subscribers):
            try:
                q.put_nowait((event_type, data))
            except Exception:
                dead.append(q)
        for q in dead:
            self.subscribers.discard(q)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        for ev, data in self.history:
            q.put_nowait((ev, data))
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)


ACTIVE_PIPELINE_JOBS: dict[str, PipelineJob] = {}


async def run_pipeline_worker(job: PipelineJob) -> None:
    """Execute Steps `from_step`..`to_step` in background without halting on client disconnects."""
    req = job.req
    output_dir = job.output_dir
    project_id = job.project_id

    step1_data: dict[str, Any] | None = None
    step2_data: dict[str, Any] | None = None
    step3_data: dict[str, Any] | None = None
    step4_data: dict[str, Any] | None = None

    def _load_prior_json(filename: str) -> dict[str, Any] | None:
        target = output_dir / filename
        if target.is_file():
            try:
                with open(target, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return None
        return None

    try:
        # Step 1: Optimize Prompt via agy
        if req.from_step <= 1 <= req.to_step:
            job.broadcast(
                "stage",
                {
                    "stage": "optimizing",
                    "step": 1,
                    "status": "running",
                    "message": "Refining spatial specification",
                    "progress": 15,
                    "project_id": project_id,
                    "mode": "live",
                },
            )
            output_dir, step1_data = await asyncio.to_thread(
                run_step1, req.prompt, output_dir
            )
            job.output_dir = output_dir
            sync_project_meta_step(output_dir, "optimizing", 1)
            job.broadcast(
                "step_complete",
                {
                    "stage": "optimizing",
                    "step": 1,
                    "status": "done",
                    "message": "Spatial specification ready",
                    "progress": 25,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            await asyncio.sleep(2.0)
        else:
            step1_data = _load_prior_json("step1_prompt.json")

        # Step 2: Generate 2x2 Turnaround Sheet via agy (image-generator)
        if req.from_step <= 2 <= req.to_step:
            if step1_data is None:
                step1_data = _load_prior_json("step1_prompt.json")
            job.broadcast(
                "stage",
                {
                    "stage": "turnaround",
                    "step": 2,
                    "status": "running",
                    "message": "Synthesizing orthographic sheet",
                    "progress": 40,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            step2_data = await asyncio.to_thread(run_step2, output_dir, step1_data)
            sync_project_meta_step(output_dir, "turnaround", 2)
            job.broadcast(
                "step_complete",
                {
                    "stage": "turnaround",
                    "step": 2,
                    "status": "done",
                    "message": "Orthographic sheet generated",
                    "progress": 55,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            await asyncio.sleep(2.0)
        else:
            step2_data = _load_prior_json("step2_image.json")

        # Step 3: Slice 2x2 Quadrant Tiles + rembg + OpenCV Alpha Filter
        if req.from_step <= 3 <= req.to_step:
            if step2_data is None:
                step2_data = _load_prior_json("step2_image.json")
            job.broadcast(
                "stage",
                {
                    "stage": "slicing",
                    "step": 3,
                    "status": "running",
                    "message": "Isolating four views",
                    "progress": 68,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            step3_data = await asyncio.to_thread(run_step3, output_dir, step2_data)
            sync_project_meta_step(output_dir, "slicing", 3)
            job.broadcast(
                "step_complete",
                {
                    "stage": "slicing",
                    "step": 3,
                    "status": "done",
                    "message": "Four RGBA views isolated",
                    "progress": 76,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            await asyncio.sleep(2.0)
        else:
            step3_data = _load_prior_json("step3_tiles.json")

        # Step 4: Multimodal View Verification & 3D Hyperparameter Tuning via agy
        if req.from_step <= 4 <= req.to_step:
            if step1_data is None:
                step1_data = _load_prior_json("step1_prompt.json")
            if step3_data is None:
                step3_data = _load_prior_json("step3_tiles.json")
            job.broadcast(
                "stage",
                {
                    "stage": "reconstructing",
                    "step": 4,
                    "status": "running",
                    "message": "Verifying views and 3D parameters",
                    "progress": 84,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            step4_data = await asyncio.to_thread(
                run_step4, output_dir, step1_data, step3_data
            )
            sync_project_meta_step(output_dir, "reconstructing", 4)
            job.broadcast(
                "step_complete",
                {
                    "stage": "reconstructing",
                    "step": 4,
                    "status": "done",
                    "message": "Views verified for 3D synthesis",
                    "progress": 88,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            await asyncio.sleep(1.0)
        else:
            step4_data = _load_prior_json("step4_3d_config.json")

        # Step 5: Hunyuan3D-2mv Mesh Synthesis (Local Apple MPS or Remote Colab GPU) + STL/GLB Export
        if req.from_step <= 5 <= req.to_step:
            if step4_data is None:
                step4_data = _load_prior_json("step4_3d_config.json")
            effective_remote_url = (
                normalize_remote_url(
                    req.remote_url
                    or load_app_config().get("colab_url")
                    or os.environ.get("COLAB_BACKEND_URL")
                )
                if req.device not in ("mps", "cpu")
                else None
            )
            step5_msg = (
                "Reconstructing watertight mesh on Colab GPU..."
                if effective_remote_url
                else "Reconstructing watertight mesh"
            )
            job.broadcast(
                "stage",
                {
                    "stage": "reconstructing",
                    "step": 5,
                    "status": "running",
                    "message": step5_msg,
                    "progress": 94,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            await asyncio.to_thread(
                run_step5,
                output_dir,
                step4_data,
                req.device,
                None,
                effective_remote_url,
            )
            sync_project_meta_step(output_dir, "complete", 5)
            job.broadcast(
                "step_complete",
                {
                    "stage": "reconstructing",
                    "step": 5,
                    "status": "done",
                    "message": "Watertight mesh synthesized",
                    "progress": 99,
                    "project_id": project_id,
                    "asset": build_asset_payload(output_dir),
                    "mode": "live",
                },
            )
            await asyncio.sleep(1.0)

        final_payload = build_asset_payload(output_dir)
        height_mm = int((final_payload.get("manifest") or {}).get("target_height_mm", 80))
        job.broadcast(
            "complete",
            {
                "stage": final_payload["stage"],
                "step": req.to_step,
                "status": "complete",
                "message": f"{height_mm} mm watertight solid",
                "progress": 100,
                "project_id": project_id,
                "asset": final_payload,
                "mode": "live",
            },
        )
    except Exception as exc:
        logger.exception("Pipeline live worker failed: %s", exc)
        job.error = str(exc)
        job.broadcast(
            "error",
            {
                "message": str(exc),
                "asset": build_asset_payload(output_dir) if output_dir and output_dir.is_dir() else None,
            },
        )
    finally:
        job.is_done = True
        # Keep job around for 5 minutes so reconnecting clients can read the final status
        await asyncio.sleep(300)
        ACTIVE_PIPELINE_JOBS.pop(project_id, None)


async def stream_live_pipeline(
    req: GenerateRequest,
    outputs_dir: Path | None = None,
    projects_dir: Path | None = None,
) -> AsyncGenerator[str, None]:
    """Execute Steps `from_step`..`to_step` in background and stream real-time SSE updates with keep-alive pings."""
    p_dir = projects_dir or PROJECTS_DIR
    o_dir = outputs_dir or OUTPUTS_DIR

    if req.from_step > req.to_step:
        yield _sse_event(
            "error",
            {"message": f"Invalid step range: from_step={req.from_step} > to_step={req.to_step}"},
        )
        return

    output_dir: Path | None = None
    if req.project_id:
        output_dir = (p_dir / req.project_id).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
    elif req.asset_name:
        output_dir = (o_dir / sanitize_slug(req.asset_name)).resolve()
    else:
        # Create a new numbered project folder `project_XXXX`
        proj = create_project(prompt=req.prompt, projects_dir=p_dir)
        req.project_id = proj["id"]
        output_dir = (p_dir / proj["id"]).resolve()

    project_key = req.project_id or output_dir.name

    # Check if a background job is already running for this project
    job = ACTIVE_PIPELINE_JOBS.get(project_key)
    if job is None or job.is_done:
        job = PipelineJob(project_id=project_key, output_dir=output_dir, req=req)
        ACTIVE_PIPELINE_JOBS[project_key] = job
        job.task = asyncio.create_task(run_pipeline_worker(job))

    # Subscribe to the background job's events with 3.0s keep-alive comment pings
    queue = job.subscribe()
    try:
        while True:
            try:
                event_type, data = await asyncio.wait_for(queue.get(), timeout=3.0)
                yield _sse_event(event_type, data)
                if event_type in ("complete", "error"):
                    break
            except asyncio.TimeoutError:
                # Send SSE comment keep-alive ping to prevent socket idle timeout
                yield ": keep-alive\n\n"
    except asyncio.CancelledError:
        logger.info(
            "SSE client disconnected from project %s. Background worker continues running.",
            project_key,
        )
        raise
    finally:
        job.unsubscribe(queue)


def create_app(
    outputs_dir: Path = OUTPUTS_DIR,
    projects_dir: Path = PROJECTS_DIR,
) -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Form 3D Studio API",
        version="0.2.0",
        description="5-Step Modular Text-to-3D Studio with Local Project Management",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    outputs_dir.mkdir(parents=True, exist_ok=True)
    projects_dir.mkdir(parents=True, exist_ok=True)

    app.mount("/outputs", StaticFiles(directory=str(outputs_dir)), name="outputs")
    app.mount("/projects", StaticFiles(directory=str(projects_dir)), name="projects")

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "device": select_compute_device(),
            "outputs_dir": str(outputs_dir),
            "projects_dir": str(projects_dir),
        }

    # System Status & Model Setup APIs
    @app.get("/api/system/status")
    def system_status() -> dict[str, Any]:
        agy_info = check_agy_status()
        models_info = check_models_status()
        saved_colab_url = normalize_remote_url(
            load_app_config().get("colab_url") or os.environ.get("COLAB_BACKEND_URL")
        )
        return {
            "status": "ok",
            "agy_installed": agy_info["installed"],
            "agy_path": agy_info["path"],
            "agy_version": agy_info["version"],
            "agy_error": agy_info["error"],
            "models_ready": models_info["ready"],
            "models": models_info,
            "device": select_compute_device(),
            "colab_url": saved_colab_url,
            "projects_dir": str(projects_dir),
        }

    @app.get("/api/system/colab/status")
    def colab_worker_status() -> dict[str, Any]:
        saved_colab_url = normalize_remote_url(
            load_app_config().get("colab_url") or os.environ.get("COLAB_BACKEND_URL")
        )
        if not saved_colab_url:
            return {"ok": False, "configured": False, "url": None}
        info = probe_remote_worker_health(saved_colab_url, timeout_sec=6.0)
        info["configured"] = True
        return info

    @app.post("/api/system/colab/probe")
    def probe_or_set_colab_worker(req: ColabProbeRequest) -> dict[str, Any]:
        normalized = normalize_remote_url(req.url)
        if not normalized:
            if req.save:
                save_app_config({"colab_url": None})
            return {
                "ok": False,
                "configured": False,
                "url": None,
                "message": "Switched to local Apple Silicon MPS synthesis.",
            }
        info = probe_remote_worker_health(normalized, timeout_sec=8.0)
        info["configured"] = True
        if req.save and info.get("ok"):
            save_app_config({"colab_url": normalized})
        return info

    @app.post("/api/system/set-agy-path")
    def set_agy_path(req: SetAgyPathRequest) -> dict[str, Any]:
        path = Path(req.path).expanduser().resolve()
        if not path.is_file():
            raise HTTPException(status_code=400, detail=f"File not found: {req.path}")
        save_app_config({"agy_path": str(path)})
        return check_agy_status()

    @app.get("/api/system/models/status")
    def models_status() -> dict[str, Any]:
        return check_models_status()

    @app.post("/api/system/models/download")
    async def download_models_endpoint() -> StreamingResponse:
        async def _stream():
            async for event in stream_download_models():
                yield _sse_event(event.get("status", "progress"), event)

        return StreamingResponse(
            _stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Local Project Management APIs
    @app.get("/api/projects")
    def get_projects() -> dict[str, Any]:
        projs = list_projects(projects_dir)
        for p in projs:
            pid = p.get("id")
            p["is_processing"] = pid in ACTIVE_PIPELINE_JOBS and not ACTIVE_PIPELINE_JOBS[pid].is_done
        return {"projects": projs}

    @app.post("/api/projects")
    def create_new_project(req: CreateProjectRequest) -> dict[str, Any]:
        meta = create_project(prompt=req.prompt, name=req.name, projects_dir=projects_dir)
        proj_dir = projects_dir / meta["id"]
        return {"project": meta, "asset": build_asset_payload(proj_dir)}

    @app.get("/api/projects/{project_id}")
    def get_project_details(project_id: str) -> dict[str, Any]:
        proj_dir = projects_dir / project_id
        if not proj_dir.is_dir():
            raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
        meta = read_project_meta(proj_dir)
        if meta:
            meta["is_processing"] = project_id in ACTIVE_PIPELINE_JOBS and not ACTIVE_PIPELINE_JOBS[project_id].is_done
        return {
            "project": meta or {"id": project_id, "name": project_id},
            "asset": build_asset_payload(proj_dir),
        }

    @app.patch("/api/projects/{project_id}")
    @app.post("/api/projects/{project_id}/rename")
    def rename_project_endpoint(project_id: str, req: RenameProjectRequest) -> dict[str, Any]:
        meta = rename_project(project_id=project_id, new_name=req.name, projects_dir=projects_dir)
        if meta is None:
            raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
        proj_dir = projects_dir / project_id
        return {"project": meta, "asset": build_asset_payload(proj_dir)}

    @app.delete("/api/projects/{project_id}")
    def delete_project_endpoint(project_id: str) -> dict[str, Any]:
        ok = delete_project(project_id, projects_dir=projects_dir)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
        return {"deleted": True, "id": project_id}

    # Legacy Asset Endpoints (outputs/)
    @app.get("/api/assets")
    def list_assets() -> dict[str, Any]:
        assets: list[dict[str, Any]] = []
        if outputs_dir.is_dir():
            dirs = sorted(
                (p for p in outputs_dir.iterdir() if p.is_dir() and not p.name.startswith(".")),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            for d in dirs:
                payload = build_asset_payload(d)
                if payload["completed_steps"]:
                    assets.append(payload)
        return {"assets": assets}

    @app.get("/api/assets/{asset_name}")
    def get_asset(asset_name: str) -> dict[str, Any]:
        slug = sanitize_slug(asset_name)
        target = (outputs_dir / slug).resolve()
        if not target.is_dir():
            raise HTTPException(status_code=404, detail=f"Asset '{asset_name}' not found")
        return build_asset_payload(target)

    # 3D Pipeline Execution Endpoint
    @app.post("/api/generate")
    async def generate_3d(req: GenerateRequest) -> StreamingResponse:
        existing_dir: Path | None = None
        if req.project_id:
            cand = projects_dir / req.project_id
            if cand.is_dir():
                existing_dir = cand
        if existing_dir is None:
            existing_dir = resolve_existing_asset_dir(req.prompt, req.asset_name)

        use_replay = False
        if req.mode == "replay":
            if existing_dir is None:
                fallback = outputs_dir / "cute_robot"
                existing_dir = fallback if fallback.is_dir() else None
            if existing_dir is not None:
                use_replay = True

        stream = (
            stream_replay_pipeline(existing_dir)
            if (use_replay and existing_dir is not None)
            else stream_live_pipeline(req, outputs_dir=outputs_dir, projects_dir=projects_dir)
        )
        return StreamingResponse(
            stream,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
