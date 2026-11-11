"""Unit and integration tests for the 5-step modular Text-to-3D pipeline."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import torch
import trimesh
from PIL import Image, ImageDraw

from steps.agy_runner import AgyExecutionError, parse_agy_json_envelope
from steps.step1_optimize_prompt import DEFAULT_SCHEMA_PATH as STEP1_SCHEMA, sanitize_slug
from steps.step2_generate_image import DEFAULT_SCHEMA_PATH as STEP2_SCHEMA
from steps.step3_process_image import slice_and_clean_2x2_sheet
from steps.step4_optimize_3d import DEFAULT_SCHEMA_PATH as STEP4_SCHEMA
from steps.step5_generate_mesh import postprocess_mesh_for_3d_printing, run_step5, select_compute_device


def test_environment_mps_and_hy3dgen_imports() -> None:
    """Verify Apple MPS availability and `hy3dgen` imports on arm64 macOS."""
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    from hy3dgen.shapegen.preprocessors import MVImageProcessorV2

    assert Hunyuan3DDiTFlowMatchingPipeline is not None
    processor = MVImageProcessorV2(size=512, border_ratio=0.15)
    assert processor.view2idx == {"front": 0, "left": 1, "back": 2, "right": 3}
    assert select_compute_device() in ("mps", "cuda", "cpu")
    if torch.backends.mps.is_available():
        assert select_compute_device() == "mps"


def test_schemas_and_agy_envelope_parser() -> None:
    """Verify JSON schemas and `parse_agy_json_envelope` parsing & validation."""
    with open(STEP1_SCHEMA, "r", encoding="utf-8") as f:
        s1 = json.load(f)
    with open(STEP2_SCHEMA, "r", encoding="utf-8") as f:
        s2 = json.load(f)
    with open(STEP4_SCHEMA, "r", encoding="utf-8") as f:
        s4 = json.load(f)

    valid_step1 = {
        "asset_name": "cute_robot",
        "character_design_spec": "Compact chibi robot with round visor and backpack",
        "turnaround_image_prompt": "2x2 orthographic sheet of cute robot on white background",
        "negative_constraints": "text, labels, grid lines, shadows",
    }
    envelope_stdout = json.dumps(
        {
            "conversation_id": "test-123",
            "status": "SUCCESS",
            "structured_output": valid_step1,
        }
    )
    parsed = parse_agy_json_envelope(envelope_stdout, schema=s1)
    assert parsed["asset_name"] == "cute_robot"

    # Test invalid status raises AgyExecutionError
    with pytest.raises(AgyExecutionError):
        parse_agy_json_envelope(json.dumps({"status": "ERROR", "error": "boom"}), schema=s1)

    # Test schema violation raises AgyExecutionError
    with pytest.raises(AgyExecutionError):
        parse_agy_json_envelope(
            json.dumps({"status": "SUCCESS", "structured_output": {"asset_name": "only_one_field"}}),
            schema=s1,
        )

    valid_step2 = {"sheet_image_path": "/tmp/sheet.png", "status": "ok"}
    assert parse_agy_json_envelope(json.dumps({"status": "SUCCESS", "structured_output": valid_step2}), schema=s2) == valid_step2

    valid_step4 = {
        "view_mapping": {"front": "/tmp/tile_tl.png", "left": "/tmp/tile_tr.png"},
        "mesh_3d_prompt": "Chibi robot watertight 3D mesh",
        "octree_resolution": 320,
        "num_inference_steps": 8,
        "guidance_scale": 5.0,
        "target_height_mm": 80.0,
        "taubin_smooth_iterations": 2,
        "qa_notes": "All views verified.",
    }
    assert parse_agy_json_envelope(json.dumps({"status": "SUCCESS", "structured_output": valid_step4}), schema=s4) == valid_step4
    assert sanitize_slug("Generate a Cute Robot!!") == "generate_a_cute_robot"


def test_step3_slice_and_clean_2x2_sheet(tmp_path: Path) -> None:
    """Verify Step 3 slices a 2x2 sheet, removes corner label specks, and keeps the main subject."""
    sheet = Image.new("RGBA", (1024, 1024), (255, 255, 255, 0))
    draw = ImageDraw.Draw(sheet)

    quadrant_centers = [(256, 256), (768, 256), (256, 768), (768, 768)]
    for cx, cy in quadrant_centers:
        # Draw main character body in center of quadrant
        draw.ellipse((cx - 90, cy - 110, cx + 90, cy + 110), fill=(60, 130, 220, 255))
        # Draw stray corner text/border noise near top-left of quadrant
        qx = 0 if cx < 512 else 512
        qy = 0 if cy < 512 else 512
        draw.rectangle((qx + 12, qy + 12, qx + 28, qy + 24), fill=(20, 20, 20, 255))

    sheet_path = tmp_path / "sheet.png"
    sheet.save(sheet_path)

    # Identity bg_remover since synthetic sheet already has RGBA alpha
    result = slice_and_clean_2x2_sheet(
        sheet_path=sheet_path,
        tiles_dir=tmp_path / "tiles",
        trim_ratio=0.02,
        bg_remover=lambda img: img.convert("RGBA"),
    )

    assert set(result["tiles"].keys()) == {"tile_tl", "tile_tr", "tile_bl", "tile_br"}
    for key, meta in result["tiles"].items():
        tile_path = Path(meta["path"])
        assert tile_path.is_file(), f"Missing tile {key}"
        assert meta["components_kept"] == 1
        assert meta["coverage_ratio"] > 0.1


def test_step5_postprocess_and_export_stl_glb(tmp_path: Path) -> None:
    """Verify Step 5 removes floaters, orients Y-up -> Z-up, scales to 80mm, seats at Z=0, and exports .stl & .glb."""
    # Create a Y-up cylinder/capsule (height=2.0 along Y, radius=0.4 along X/Z) + a tiny disconnected floater
    main_body = trimesh.creation.cylinder(radius=0.4, height=2.0, sections=24)
    # Rotate cylinder so its long axis is Y-up (Hunyuan3D native convention)
    rot_to_yup = trimesh.transformations.rotation_matrix(np.pi / 2.0, [1.0, 0.0, 0.0])
    main_body.apply_transform(rot_to_yup)

    floater = trimesh.creation.icosphere(subdivisions=1, radius=0.05)
    floater.apply_translation([3.0, 3.0, 3.0])
    raw_mesh = trimesh.util.concatenate([main_body, floater])

    processed = postprocess_mesh_for_3d_printing(
        raw_mesh,
        target_height_mm=80.0,
        taubin_smooth_iterations=1,
    )

    bounds = processed.bounds
    extents = bounds[1] - bounds[0]
    # Z height should be 80.0 mm
    assert np.isclose(extents[2], 80.0, atol=0.5)
    # Seated flat on Z = 0
    assert np.isclose(bounds[0][2], 0.0, atol=1e-4)
    # Centered on X=0, Y=0
    assert np.isclose(0.5 * (bounds[0][0] + bounds[1][0]), 0.0, atol=1e-4)
    assert np.isclose(0.5 * (bounds[0][1] + bounds[1][1]), 0.0, atol=1e-4)
    # Floater was removed, so X/Y width is ~32mm (not >100mm)
    assert extents[0] < 40.0

    # Test run_step5 end-to-end with mock synthesizer
    tile_img = Image.new("RGBA", (512, 512), (255, 255, 255, 255))
    tile_path = tmp_path / "tile_tl.png"
    tile_img.save(tile_path)

    step4_data = {
        "view_mapping": {"front": str(tile_path)},
        "mesh_3d_prompt": "Test robot mesh",
        "octree_resolution": 256,
        "num_inference_steps": 5,
        "guidance_scale": 5.0,
        "target_height_mm": 80.0,
        "taubin_smooth_iterations": 1,
        "qa_notes": "Unit test",
    }
    manifest = run_step5(
        output_dir=tmp_path,
        step4_data=step4_data,
        mesh_synthesizer=lambda **kwargs: raw_mesh,
    )
    assert Path(manifest["stl_path"]).is_file()
    assert Path(manifest["glb_path"]).is_file()
    assert Path(manifest["stl_path"]).stat().st_size > 100
    assert Path(manifest["glb_path"]).stat().st_size > 100


def test_server_api_endpoints_and_sse_replay() -> None:
    """Verify FastAPI bridge endpoints (`/api/health`, `/api/assets`, `/api/generate` SSE replay)."""
    from fastapi.testclient import TestClient
    from server import app, build_asset_payload
    from steps.step1_optimize_prompt import REPO_ROOT

    robot_dir = REPO_ROOT / "outputs" / "cute_robot"
    if robot_dir.is_dir():
        payload = build_asset_payload(robot_dir)
        assert payload["slug"] == "cute_robot"
        assert 5 in payload["completed_steps"]
        assert payload["urls"]["glb"] == "/outputs/cute_robot/cute_robot.glb"
        assert payload["urls"]["stl"] == "/outputs/cute_robot/cute_robot.stl"
        assert len(payload["tiles"]) == 4

    client = TestClient(app)
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    assets_res = client.get("/api/assets")
    assert assets_res.status_code == 200
    assets = assets_res.json()["assets"]
    assert isinstance(assets, list)
    if robot_dir.is_dir():
        assert any(a["slug"] == "cute_robot" for a in assets)

        single_res = client.get("/api/assets/cute_robot")
        assert single_res.status_code == 200
        assert single_res.json()["asset_name"] == "cute_robot"

        sse_res = client.post(
            "/api/generate",
            json={"prompt": "Generate a cute robot", "mode": "replay"},
        )
        assert sse_res.status_code == 200
        assert "event: stage" in sse_res.text
        assert "event: complete" in sse_res.text

