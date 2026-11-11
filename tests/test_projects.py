"""Unit tests for project management, system status, and model download APIs."""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from server import create_app
from steps.project_manager import (
    create_project,
    delete_project,
    list_projects,
    read_project_meta,
    rename_project,
)


def test_project_lifecycle_crud(tmp_path: Path):
    """Verify project creation, listing, renaming, and deletion in an isolated directory."""
    projects_dir = tmp_path / "projects"

    # 1. Initially empty
    assert list_projects(projects_dir) == []

    # 2. Create project 1
    p1 = create_project("Generate a cute robot", name="Robot Companion", projects_dir=projects_dir)
    assert p1["id"] == "project_0001"
    assert p1["name"] == "Robot Companion"
    assert (projects_dir / "project_0001" / "project.json").is_file()

    # 3. Create project 2
    p2 = create_project("Ceramic vase", projects_dir=projects_dir)
    assert p2["id"] == "project_0002"
    assert p2["name"] == "Ceramic Vase"

    # 4. List projects
    projs = list_projects(projects_dir)
    assert len(projs) == 2
    assert projs[0]["id"] == "project_0002"  # Newest first

    # 5. Rename project 1
    renamed = rename_project("project_0001", "Mecha Friend", projects_dir=projects_dir)
    assert renamed is not None
    assert renamed["name"] == "Mecha Friend"

    meta1 = read_project_meta(projects_dir / "project_0001")
    assert meta1["name"] == "Mecha Friend"

    # 6. Delete project 2
    assert delete_project("project_0002", projects_dir=projects_dir) is True
    assert not (projects_dir / "project_0002").exists()
    assert len(list_projects(projects_dir)) == 1


def test_server_project_api_endpoints(tmp_path: Path):
    """Verify FastAPI endpoints for project management and system status."""
    projects_dir = tmp_path / "projects"
    outputs_dir = tmp_path / "outputs"
    app = create_app(outputs_dir=outputs_dir, projects_dir=projects_dir)
    client = TestClient(app)

    # 1. System status check
    status_res = client.get("/api/system/status")
    assert status_res.status_code == 200
    status_data = status_res.json()
    assert "agy_installed" in status_data
    assert "models_ready" in status_data
    assert "device" in status_data

    # 2. Initially empty projects list
    p_res = client.get("/api/projects")
    assert p_res.status_code == 200
    assert p_res.json()["projects"] == []

    # 3. Create project via POST /api/projects
    create_res = client.post(
        "/api/projects",
        json={"prompt": "Generate a sleek drone", "name": "Aero Drone"},
    )
    assert create_res.status_code == 200
    created = create_res.json()
    assert created["project"]["id"] == "project_0001"
    assert created["project"]["name"] == "Aero Drone"

    # 4. Get single project
    get_res = client.get("/api/projects/project_0001")
    assert get_res.status_code == 200
    assert get_res.json()["project"]["name"] == "Aero Drone"

    # 5. Rename project
    rename_res = client.patch(
        "/api/projects/project_0001",
        json={"name": "Aero Drone Mk II"},
    )
    assert rename_res.status_code == 200
    assert rename_res.json()["project"]["name"] == "Aero Drone Mk II"

    # 6. Delete project
    del_res = client.delete("/api/projects/project_0001")
    assert del_res.status_code == 200
    assert del_res.json()["deleted"] is True
    assert client.get("/api/projects").json()["projects"] == []


def test_generate_creates_new_project_without_replay_hijack(tmp_path: Path):
    """Verify that submitting a prompt to /api/generate creates a new project and does not hijack into replay."""
    projects_dir = tmp_path / "projects"
    outputs_dir = tmp_path / "outputs"
    app = create_app(outputs_dir=outputs_dir, projects_dir=projects_dir)
    client = TestClient(app)

    # Pre-seed an existing completed asset in outputs/cute_robot
    old_asset_dir = outputs_dir / "cute_robot"
    old_asset_dir.mkdir(parents=True, exist_ok=True)
    (old_asset_dir / "step1_prompt.json").write_text(json.dumps({"asset_name": "cute_robot"}), encoding="utf-8")
    (old_asset_dir / "cute_robot.glb").write_bytes(b"dummy glb")

    # POST /api/generate with a prompt and NO project_id
    res = client.post(
        "/api/generate",
        json={"prompt": "Generate a cute robot", "mode": "live", "from_step": 1, "to_step": 1},
    )
    assert res.status_code == 200
    content = res.text
    # Stream content must reference the new project_0001, not a replay
    assert "project_0001" in content
    assert '"mode": "replay"' not in content
    # New sequential project folder must have been created
    assert (projects_dir / "project_0001" / "project.json").is_file()
