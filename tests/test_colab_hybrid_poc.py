"""End-to-end POC verification tests for Google Colab Pro Hybrid Backend (`colab_3d_worker.ipynb`, `step5_generate_mesh.py`, `server.py`)."""

from __future__ import annotations

import ast
import base64
import json
import threading
import time
from pathlib import Path
from typing import Any

import httpx
import trimesh
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.testclient import TestClient
from PIL import Image

from server import create_app
from steps.step5_generate_mesh import (
    normalize_remote_url,
    postprocess_mesh_for_3d_printing,
    probe_remote_worker_health,
    run_step5,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
NOTEBOOK_PATH = REPO_ROOT / "colab" / "colab_3d_worker.ipynb"


def test_colab_notebook_structure_and_python_syntax() -> None:
    """Verify `colab/colab_3d_worker.ipynb` is valid JSON, all code cells compile, and key features exist."""
    import pytest
    if not NOTEBOOK_PATH.is_file():
        pytest.skip(f"Colab worker notebook not found at {NOTEBOOK_PATH} (ignored or external)")
    nb = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))

    assert nb.get("nbformat") == 4
    cells = nb.get("cells", [])
    assert len(cells) >= 8

    combined_source = ""
    code_cells = [c for c in cells if c.get("cell_type") == "code"]
    assert len(code_cells) >= 7

    for idx, cell in enumerate(code_cells, start=1):
        src = "".join(cell.get("source", []))
        combined_source += "\n" + src
        # Ensure every code cell in the notebook is valid Python syntax
        ast.parse(src, filename=f"colab_3d_worker_cell_{idx}.py")

    # Verify required POC components in notebook
    assert "HF_HUB_ENABLE_HF_TRANSFER" in combined_source
    assert "trycloudflare.com" in combined_source
    assert "/api/v1/health" in combined_source
    assert "/api/v1/generate-mesh" in combined_source
    assert "Hunyuan3DDiTFlowMatchingPipeline" in combined_source
    assert "drive.mount" in combined_source
    assert "runtime.unassign()" in combined_source


def test_normalize_remote_url() -> None:
    """Verify Cloudflare tunnel URLs are normalized cleanly."""
    assert normalize_remote_url("") is None
    assert normalize_remote_url("   ") is None
    assert (
        normalize_remote_url("https://demo-cube-123.trycloudflare.com/")
        == "https://demo-cube-123.trycloudflare.com"
    )
    assert (
        normalize_remote_url("demo-cube-123.trycloudflare.com/api/v1/health")
        == "https://demo-cube-123.trycloudflare.com"
    )
    assert (
        normalize_remote_url("https://demo-cube-123.trycloudflare.com/api/v1/generate-mesh")
        == "https://demo-cube-123.trycloudflare.com"
    )


def _create_mock_colab_worker_app() -> FastAPI:
    """Create a lightweight FastAPI server mirroring `colab/colab_3d_worker.ipynb` endpoints."""
    from fastapi.responses import Response

    worker = FastAPI()
    job_artifacts: dict[str, bytes] = {}

    @worker.get("/health")
    @worker.get("/api/v1/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "form3d-colab-worker",
            "ready": True,
            "busy": False,
            "device": "cuda",
            "gpu_name": "NVIDIA A100-SXM4-40GB",
            "vram_total_gb": 40.0,
            "vram_allocated_gb": 5.8,
            "vram_free_gb": 34.2,
            "recommended_octree_resolution": 512,
            "model_id": "tencent/Hunyuan3D-2mv",
            "drive_mounted": True,
            "drive_output_dir": "/content/drive/MyDrive/3d_generator_outputs",
            "jobs_completed": 3,
            "uptime_seconds": 124.5,
        }

    @worker.get("/api/v1/jobs/{job_id}/{filename}")
    def download_artifact(job_id: str, filename: str) -> Response:
        content = job_artifacts.get(f"{job_id}/{filename}", b"")
        return Response(content=content, media_type="application/octet-stream")

    @worker.post("/api/v1/generate-mesh")
    async def generate_mesh(
        front: UploadFile | None = File(default=None),
        left: UploadFile | None = File(default=None),
        back: UploadFile | None = File(default=None),
        right: UploadFile | None = File(default=None),
        asset_name: str = Form(default="model_3d"),
        octree_resolution: int = Form(default=384),
        num_inference_steps: int = Form(default=8),
        guidance_scale: float = Form(default=5.0),
        target_height_mm: float = Form(default=80.0),
        taubin_smooth_iterations: int = Form(default=1),
        include_base64: bool = Form(default=False),
    ) -> dict[str, Any]:
        views_received = [
            k
            for k, u in (("front", front), ("left", left), ("back", back), ("right", right))
            if u is not None
        ]
        raw_box = trimesh.creation.box(extents=[0.6, 0.9, 0.5])
        mesh = postprocess_mesh_for_3d_printing(
            raw_box,
            target_height_mm=float(target_height_mm),
            taubin_smooth_iterations=int(taubin_smooth_iterations),
        )
        stl_bytes = mesh.export(file_type="stl")
        glb_bytes = mesh.export(file_type="glb")
        job_id = "20261110_poc001"
        job_artifacts[f"{job_id}/{asset_name}.stl"] = stl_bytes
        job_artifacts[f"{job_id}/{asset_name}.glb"] = glb_bytes

        return {
            "status": "ok",
            "job_id": job_id,
            "asset_name": asset_name,
            "device": "cuda (NVIDIA A100-SXM4-40GB)",
            "gpu_name": "NVIDIA A100-SXM4-40GB",
            "inference_seconds": 7.42,
            "drive_saved_dir": f"/content/drive/MyDrive/3d_generator_outputs/{job_id}_{asset_name}",
            "manifest": {
                "job_id": job_id,
                "asset_name": asset_name,
                "views_used": views_received,
                "octree_resolution": octree_resolution,
                "num_inference_steps": num_inference_steps,
                "guidance_scale": guidance_scale,
                "target_height_mm": target_height_mm,
            },
            "download_urls": {
                "stl": f"/api/v1/jobs/{job_id}/{asset_name}.stl",
                "glb": f"/api/v1/jobs/{job_id}/{asset_name}.glb",
            },
            "stl_base64": base64.b64encode(stl_bytes).decode("ascii") if include_base64 else None,
            "glb_base64": base64.b64encode(glb_bytes).decode("ascii") if include_base64 else None,
        }

    return worker


def test_remote_colab_worker_end_to_end_poc(tmp_path: Path) -> None:
    """Spin up a live mock Colab worker, probe health check, and run remote Step 5 synthesis."""
    worker_app = _create_mock_colab_worker_app()
    port = 18765
    config = uvicorn.Config(worker_app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    remote_url = f"http://127.0.0.1:{port}"
    for _ in range(30):
        try:
            if httpx.get(f"{remote_url}/health", timeout=1.0).status_code == 200:
                break
        except Exception:
            time.sleep(0.1)

    try:
        # 1. Verify health check probe
        health_info = probe_remote_worker_health(remote_url)
        assert health_info["ok"] is True
        assert health_info["gpu_name"] == "NVIDIA A100-SXM4-40GB"
        assert health_info["vram_total_gb"] == 40.0
        assert health_info["drive_mounted"] is True

        # 2. Verify Studio API `/api/system/colab/probe` endpoint
        studio_app = create_app(outputs_dir=tmp_path / "outputs", projects_dir=tmp_path / "projects")
        client = TestClient(studio_app)
        probe_res = client.post(
            "/api/system/colab/probe",
            json={"url": remote_url, "save": False},
        )
        assert probe_res.status_code == 200
        probe_json = probe_res.json()
        assert probe_json["ok"] is True
        assert probe_json["gpu_name"] == "NVIDIA A100-SXM4-40GB"

        # 3. Verify `run_step5` offloading 4 multi-view PNG tiles to the remote worker
        run_dir = tmp_path / "poc_robot"
        tiles_dir = run_dir / "tiles"
        tiles_dir.mkdir(parents=True)

        view_mapping: dict[str, str] = {}
        for view_key, tile_name in (
            ("front", "tile_tl.png"),
            ("left", "tile_tr.png"),
            ("back", "tile_bl.png"),
            ("right", "tile_br.png"),
        ):
            p = tiles_dir / tile_name
            Image.new("RGBA", (256, 256), (100, 160, 240, 255)).save(p)
            view_mapping[view_key] = str(p)

        (run_dir / "step1_prompt.json").write_text(
            json.dumps({"asset_name": "poc_robot"}), encoding="utf-8"
        )
        step4_data = {
            "view_mapping": view_mapping,
            "octree_resolution": 384,
            "num_inference_steps": 8,
            "guidance_scale": 5.0,
            "target_height_mm": 80.0,
            "taubin_smooth_iterations": 1,
        }
        (run_dir / "step4_3d_config.json").write_text(
            json.dumps(step4_data), encoding="utf-8"
        )

        manifest = run_step5(run_dir, step4_data=step4_data, remote_url=remote_url)
        assert manifest["asset_name"] == "poc_robot"
        assert "NVIDIA A100" in manifest["device"]
        assert manifest["inference_seconds"] == 7.42
        assert manifest["remote_job_id"] == "20261110_poc001"
        assert Path(manifest["stl_path"]).is_file()
        assert Path(manifest["glb_path"]).is_file()
        assert Path(manifest["mesh_preview_path"]).is_file()
        assert abs(manifest["mesh_stats"]["extents_mm"]["z_height"] - 80.0) < 0.5
    finally:
        server.should_exit = True
        thread.join(timeout=3.0)
