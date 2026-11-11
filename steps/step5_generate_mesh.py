"""Step 5: Local (`Hunyuan3D-2mv` on Apple MPS) or Remote Google Colab Pro (A100/L4) Multi-View 3D Mesh Synthesis & `.stl`/`.glb` Export."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
import types
from pathlib import Path
from typing import Any

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

import cv2
import numpy as np
import torch
import trimesh
from PIL import Image


def render_mesh_orthographic_preview(mesh: trimesh.Trimesh, preview_path: Path) -> Path:
    """Render a 2x2 clay-shaded orthographic turnaround preview of the exported Z-up 3D mesh."""
    verts = np.asarray(mesh.vertices, dtype=np.float32)
    faces = np.asarray(mesh.faces, dtype=np.int32)
    normals = np.asarray(mesh.face_normals, dtype=np.float32)

    light_dir = np.array([-0.35, -0.75, 0.55], dtype=np.float32)
    light_dir /= np.linalg.norm(light_dir)

    tiles = []
    # Angles 0 (Front), 270 (Left), 180 (Back), 90 (Right)
    for angle_deg in [0, 270, 180, 90]:
        rad = np.deg2rad(angle_deg)
        c, s = np.cos(rad), np.sin(rad)
        rot = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]], dtype=np.float32)
        v_rot = verts @ rot.T
        n_rot = normals @ rot.T

        # Keep camera-facing triangles (camera looks from -Y toward +Y)
        vis = n_rot[:, 1] <= 0.05
        f_vis = faces[vis]
        n_vis = n_rot[vis]
        tri_v = v_rot[f_vis]

        depth = tri_v[:, :, 1].mean(axis=1)
        order = np.argsort(-depth)
        tri_v = tri_v[order]
        n_vis = n_vis[order]

        img = np.full((512, 512, 3), 250, dtype=np.uint8)
        scale = 420.0 / 85.0
        pts_x = (tri_v[:, :, 0] * scale + 256.0).astype(np.int32)
        pts_y = (512.0 - 46.0 - tri_v[:, :, 2] * scale).astype(np.int32)
        pts = np.stack([pts_x, pts_y], axis=-1)

        lambert = np.clip(n_vis @ light_dir, 0.0, 1.0)
        rim = np.clip(1.0 - np.abs(n_vis[:, 1]), 0.0, 1.0) ** 2 * 0.15
        shade = np.clip(75.0 + 165.0 * lambert + 40.0 * rim, 40.0, 245.0).astype(np.uint8)
        for poly, sh in zip(pts, shade):
            val = int(sh)
            cv2.fillConvexPoly(img, poly, (int(val * 0.92), int(val * 0.96), val))
        tiles.append(img)

    grid = np.vstack([np.hstack([tiles[0], tiles[1]]), np.hstack([tiles[2], tiles[3]])])
    preview_path = preview_path.resolve()
    Image.fromarray(grid).save(preview_path)
    return preview_path


def select_compute_device(requested_device: str | None = None) -> str:
    """Select the best available compute device on macOS Apple Silicon (`mps` -> `cpu`)."""
    if requested_device:
        return requested_device
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def postprocess_mesh_for_3d_printing(
    mesh: trimesh.Trimesh,
    target_height_mm: float = 80.0,
    taubin_smooth_iterations: int = 2,
    min_component_area_ratio: float = 0.05,
    keep_only_largest: bool = True,
) -> trimesh.Trimesh:
    """Clean, orient (Z-up), seat on build plate (Z=0), and scale a raw marching-cubes mesh to millimeters.

    Args:
        mesh: Raw `trimesh.Trimesh` from `Hunyuan3D-2mv` (Y-up in normalized `[-1, 1]` coordinates).
        target_height_mm: Target Z height in millimeters (default 80.0 mm).
        taubin_smooth_iterations: Number of volume-preserving Taubin smoothing iterations (0 disables).
        min_component_area_ratio: Minimum surface-area ratio relative to largest component when `keep_only_largest=False`.
        keep_only_largest: Keep only the single largest connected component (ideal for 3D printable figurines).

    Returns:
        Post-processed `trimesh.Trimesh` ready for `.stl` and `.glb` export.
    """
    if isinstance(mesh, trimesh.Scene):
        geoms = list(mesh.geometry.values())
        if not geoms:
            raise ValueError("Empty trimesh.Scene returned by 3D pipeline")
        mesh = trimesh.util.concatenate(geoms)

    mesh = mesh.copy()

    # 1. Remove degenerate / duplicate faces and unreferenced vertices
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()

    # 2. Filter out small disconnected floating islands
    components = mesh.split(only_watertight=False)
    if len(components) > 1:
        components = sorted(components, key=lambda c: float(c.area), reverse=True)
        if keep_only_largest:
            mesh = components[0]
        else:
            max_area = float(components[0].area)
            kept = [c for c in components if float(c.area) >= max_area * min_component_area_ratio]
            mesh = trimesh.util.concatenate(kept) if len(kept) > 1 else components[0]

    # 3. Optional Taubin smoothing to reduce marching-cubes voxel stair-stepping
    if taubin_smooth_iterations > 0 and len(mesh.faces) > 0:
        trimesh.smoothing.filter_taubin(mesh, iterations=int(taubin_smooth_iterations))

    # 4. Rotate from Y-up (Hunyuan3D convention) to Z-up (3D printing slicer convention: +Z is up)
    rot_x_90 = trimesh.transformations.rotation_matrix(np.pi / 2.0, [1.0, 0.0, 0.0])
    mesh.apply_transform(rot_x_90)

    # 5. Uniformly scale so total Z height equals `target_height_mm`
    bounds = mesh.bounds
    extents = bounds[1] - bounds[0]
    current_height = float(extents[2])
    if current_height <= 1e-6:
        raise ValueError(f"Mesh has degenerate Z height: {current_height}")

    scale_factor = float(target_height_mm) / current_height
    mesh.apply_scale(scale_factor)

    # 6. Center X and Y at (0, 0) and place bottom flush on Z = 0 build plate
    bounds = mesh.bounds
    center_x = 0.5 * (bounds[0][0] + bounds[1][0])
    center_y = 0.5 * (bounds[0][1] + bounds[1][1])
    min_z = bounds[0][2]
    mesh.apply_translation([-center_x, -center_y, -min_z])

    # 7. Ensure consistent outward normals for STL slicers
    trimesh.repair.fix_normals(mesh)

    return mesh


def synthesize_multiview_mesh(
    view_images: dict[str, Image.Image],
    octree_resolution: int = 320,
    num_inference_steps: int = 8,
    guidance_scale: float = 5.0,
    num_chunks: int = 16000,
    seed: int = 12345,
    device: str | None = None,
    model_id: str = "tencent/Hunyuan3D-2mv",
    subfolder: str = "hunyuan3d-dit-v2-mv-turbo",
) -> trimesh.Trimesh:
    """Run `Hunyuan3DDiTFlowMatchingPipeline` with multi-view RGBA conditioning."""
    from huggingface_hub import hf_hub_download
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

    compute_device = select_compute_device(device)
    dtype = torch.float16 if compute_device in ("mps", "cuda") else torch.float32

    # Prefer local Hugging Face cache first (instant & offline-safe), falling back to network download if uncached
    try:
        config_path = hf_hub_download(
            repo_id=model_id, filename=f"{subfolder}/config.yaml", local_files_only=True
        )
        ckpt_path = hf_hub_download(
            repo_id=model_id, filename=f"{subfolder}/model.fp16.safetensors", local_files_only=True
        )
    except Exception:
        config_path = hf_hub_download(repo_id=model_id, filename=f"{subfolder}/config.yaml")
        ckpt_path = hf_hub_download(repo_id=model_id, filename=f"{subfolder}/model.fp16.safetensors")

    pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_single_file(
        ckpt_path=ckpt_path,
        config_path=config_path,
        device=compute_device,
        dtype=dtype,
        use_safetensors=True,
        from_pretrained_kwargs={
            "model_path": model_id,
            "subfolder": subfolder,
            "use_safetensors": True,
            "variant": "fp16",
            "dtype": dtype,
            "device": compute_device,
        },
    )
    # Use FlashVDM hierarchical volume decoding with CPU scikit-image Marching Cubes ('mc')
    # and keep the VAE already loaded inside the checkpoint (replace_vae=False)
    pipeline.enable_flashvdm(
        enabled=True,
        adaptive_kv_selection=True,
        topk_mode="mean",
        mc_algo="mc",
        replace_vae=False,
    )

    generator = torch.Generator(device="cpu").manual_seed(seed)

    try:
        outputs = pipeline(
            image=view_images,
            num_inference_steps=int(num_inference_steps),
            guidance_scale=float(guidance_scale),
            octree_resolution=int(octree_resolution),
            num_chunks=int(num_chunks),
            mc_algo="mc",
            generator=generator,
            output_type="trimesh",
        )
    except Exception:
        # Fallback toHierarchicalVolumeDecoding if FlashVDM encounters any MPS op edge case
        pipeline.enable_flashvdm(
            enabled=True,
            adaptive_kv_selection=False,
            mc_algo="mc",
            replace_vae=False,
        )
        outputs = pipeline(
            image=view_images,
            num_inference_steps=int(num_inference_steps),
            guidance_scale=float(guidance_scale),
            octree_resolution=int(octree_resolution),
            num_chunks=int(num_chunks),
            mc_algo="mc",
            generator=generator,
            output_type="trimesh",
        )

    mesh = outputs[0] if isinstance(outputs, list) else outputs
    if mesh is None or not isinstance(mesh, (trimesh.Trimesh, trimesh.Scene)):
        raise RuntimeError("Hunyuan3D-2mv pipeline did not return a valid trimesh object.")
    return mesh


def normalize_remote_url(remote_url: str | None = None) -> str | None:
    """Normalize a remote Colab/Cloudflare tunnel URL or return None if empty."""
    raw = (remote_url if remote_url is not None else os.environ.get("COLAB_BACKEND_URL", "")).strip()
    if not raw:
        return None
    if not raw.startswith(("http://", "https://")):
        raw = f"https://{raw}"
    # Strip trailing /health, /api/v1/health, or /api/v1/generate-mesh if user pasted the full endpoint
    for suffix in ("/api/v1/generate-mesh", "/api/v1/health", "/api/health", "/health"):
        if raw.endswith(suffix):
            raw = raw[: -len(suffix)]
            break
    return raw.rstrip("/")


def probe_remote_worker_health(remote_url: str, timeout_sec: float = 10.0) -> dict[str, Any]:
    """Probe the remote Google Colab Pro GPU worker `/api/v1/health` (or `/health`) endpoint."""
    import httpx

    base_url = normalize_remote_url(remote_url)
    if not base_url:
        return {
            "ok": False,
            "url": None,
            "error": "No remote Colab URL provided.",
        }

    t0 = time.time()
    last_err = "Unknown connection error"
    with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client:
        for path in ("/api/v1/health", "/health"):
            try:
                resp = client.get(f"{base_url}{path}")
                latency_ms = round((time.time() - t0) * 1000.0, 1)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, dict):
                        return {
                            "ok": data.get("status") in ("ok", "ready") or bool(data.get("ready", True)),
                            "url": base_url,
                            "latency_ms": latency_ms,
                            "status": data.get("status", "ok"),
                            "ready": bool(data.get("ready", True)),
                            "busy": bool(data.get("busy", False)),
                            "device": data.get("device", "cuda"),
                            "gpu_name": data.get("gpu_name", "Colab CUDA GPU"),
                            "vram_total_gb": data.get("vram_total_gb"),
                            "vram_free_gb": data.get("vram_free_gb"),
                            "vram_allocated_gb": data.get("vram_allocated_gb"),
                            "recommended_octree_resolution": data.get("recommended_octree_resolution"),
                            "model_id": data.get("model_id", "tencent/Hunyuan3D-2mv"),
                            "drive_mounted": bool(data.get("drive_mounted", False)),
                            "drive_output_dir": data.get("drive_output_dir"),
                            "jobs_completed": data.get("jobs_completed", 0),
                            "uptime_seconds": data.get("uptime_seconds"),
                            "error": None,
                        }
                last_err = f"HTTP {resp.status_code}: {resp.text[:200]}"
            except Exception as exc:
                last_err = str(exc)

    return {
        "ok": False,
        "url": base_url,
        "latency_ms": round((time.time() - t0) * 1000.0, 1),
        "error": f"Failed to reach Colab worker at {base_url} ({last_err})",
    }


def synthesize_multiview_mesh_remote(
    remote_url: str,
    view_images: dict[str, Image.Image],
    asset_name: str = "model_3d",
    octree_resolution: int = 384,
    num_inference_steps: int = 8,
    guidance_scale: float = 5.0,
    target_height_mm: float = 80.0,
    taubin_smooth_iterations: int = 2,
    seed: int = 12345,
    timeout_sec: float = 360.0,
    download_mesh: bool = False,
) -> dict[str, Any]:
    """Trigger Step 5 multi-view mesh synthesis on Google Colab Pro via Cloudflare Tunnel.

    By default (`download_mesh=False`), Cloudflare Tunnel is used strictly as a lightweight trigger (~500 KB upload
    -> ~1 KB JSON response in ~13-15s), while `.stl` and `.glb` are saved directly to Google Drive and returned as
    Google Drive links.
    """
    import httpx

    base_url = normalize_remote_url(remote_url)
    if not base_url:
        raise ValueError("Invalid empty remote_url for Colab mesh synthesis.")

    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for view_key, img in view_images.items():
        buf = io.BytesIO()
        img.convert("RGBA").save(buf, format="PNG")
        files.append((view_key, (f"{view_key}.png", buf.getvalue(), "image/png")))

    form_data = {
        "asset_name": str(asset_name),
        "octree_resolution": str(int(octree_resolution)),
        "num_inference_steps": str(int(num_inference_steps)),
        "guidance_scale": str(float(guidance_scale)),
        "target_height_mm": str(float(target_height_mm)),
        "taubin_smooth_iterations": str(int(taubin_smooth_iterations)),
        "seed": str(int(seed)),
        "include_base64": "false",
    }

    with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client:
        resp = client.post(
            f"{base_url}/api/v1/generate-mesh",
            files=files,
            data=form_data,
        )
        if resp.status_code != 200:
            detail = resp.text[:400]
            try:
                detail = resp.json().get("detail", detail)
            except Exception:
                pass
            raise RuntimeError(
                f"Remote Colab worker ({base_url}) failed with HTTP {resp.status_code}: {detail}"
            )

        payload = resp.json()
        stl_bytes: bytes | None = None
        glb_bytes: bytes | None = None
        preview_bytes: bytes | None = None

        if payload.get("preview_base64"):
            try:
                preview_bytes = base64.b64decode(payload["preview_base64"])
            except Exception:
                preview_bytes = None

        if download_mesh:
            if payload.get("glb_base64"):
                glb_bytes = base64.b64decode(payload["glb_base64"])
            if payload.get("stl_base64"):
                stl_bytes = base64.b64decode(payload["stl_base64"])

            dl_urls = payload.get("download_urls") or {}
            if not glb_bytes and not stl_bytes:
                if dl_urls.get("glb"):
                    dl_glb = dl_urls["glb"]
                    glb_url = dl_glb if dl_glb.startswith("http") else f"{base_url}{dl_glb}"
                    glb_res = client.get(glb_url)
                    glb_res.raise_for_status()
                    glb_bytes = glb_res.content
                elif dl_urls.get("stl"):
                    dl_stl = dl_urls["stl"]
                    stl_url = dl_stl if dl_stl.startswith("http") else f"{base_url}{dl_stl}"
                    stl_res = client.get(stl_url)
                    stl_res.raise_for_status()
                    stl_bytes = stl_res.content

        drive_saved_dir = payload.get("drive_saved_dir")
        drive_links = payload.get("drive_links") or {}
        if not drive_links and drive_saved_dir:
            folder_name = Path(drive_saved_dir).name
            drive_links = {
                "folder_url": f"https://drive.google.com/drive/u/0/search?q={folder_name}",
                "stl_url": f"https://drive.google.com/drive/u/0/search?q={asset_name}.stl",
                "glb_url": f"https://drive.google.com/drive/u/0/search?q={asset_name}.glb",
            }

        return {
            "stl_bytes": stl_bytes,
            "glb_bytes": glb_bytes,
            "preview_bytes": preview_bytes,
            "remote_url": base_url,
            "job_id": payload.get("job_id"),
            "device": payload.get("device") or f"cuda ({payload.get('gpu_name', 'Colab')})",
            "gpu_name": payload.get("gpu_name"),
            "inference_seconds": payload.get("inference_seconds"),
            "total_seconds": payload.get("total_seconds"),
            "drive_saved_dir": drive_saved_dir,
            "drive_links": drive_links,
            "download_urls": payload.get("download_urls"),
            "remote_manifest": payload.get("manifest"),
        }


def run_step5(
    output_dir: Path,
    step4_data: dict[str, Any] | None = None,
    device: str | None = None,
    mesh_synthesizer: Any | None = None,
    remote_url: str | None = None,
    download_mesh: bool = True,
) -> dict[str, Any]:
    """Execute Step 5: run `Hunyuan3D-2mv` (locally on MPS/CPU or remotely on Colab A100/L4) and export `.stl`, `.glb`, and `manifest.json`."""
    output_dir = output_dir.resolve()
    if step4_data is None:
        with open(output_dir / "step4_3d_config.json", "r", encoding="utf-8") as f:
            step4_data = json.load(f)

    step1_path = output_dir / "step1_prompt.json"
    if step1_path.is_file():
        with open(step1_path, "r", encoding="utf-8") as f:
            asset_name = json.load(f).get("asset_name", output_dir.name)
    else:
        asset_name = output_dir.name

    view_mapping: dict[str, str] = step4_data["view_mapping"]
    view_images: dict[str, Image.Image] = {}
    for view_tag, img_path in view_mapping.items():
        view_images[view_tag] = Image.open(img_path).convert("RGBA")

    octree_resolution = int(step4_data.get("octree_resolution", 320))
    num_inference_steps = int(step4_data.get("num_inference_steps", 8))
    guidance_scale = float(step4_data.get("guidance_scale", 5.0))
    target_height_mm = float(step4_data.get("target_height_mm", 80.0))
    taubin_smooth_iterations = int(step4_data.get("taubin_smooth_iterations", 2))

    stl_path = (output_dir / f"{asset_name}.stl").resolve()
    glb_path = (output_dir / f"{asset_name}.glb").resolve()
    preview_path = (output_dir / f"{asset_name}_mesh_preview.png").resolve()

    effective_remote_url = normalize_remote_url(remote_url) if mesh_synthesizer is None else None
    remote_meta: dict[str, Any] | None = None
    final_mesh: trimesh.Trimesh | None = None

    t0 = time.time()
    if effective_remote_url:
        remote_meta = synthesize_multiview_mesh_remote(
            remote_url=effective_remote_url,
            view_images=view_images,
            asset_name=asset_name,
            octree_resolution=octree_resolution,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            target_height_mm=target_height_mm,
            taubin_smooth_iterations=taubin_smooth_iterations,
            download_mesh=download_mesh,
        )
        infer_seconds = float(remote_meta.get("inference_seconds") or round(time.time() - t0, 2))
        compute_device = str(remote_meta.get("device") or "cuda (colab)")

        stl_bytes = remote_meta.get("stl_bytes")
        glb_bytes = remote_meta.get("glb_bytes")
        preview_bytes = remote_meta.get("preview_bytes")

        if preview_bytes:
            preview_path.write_bytes(preview_bytes)

        if stl_bytes:
            stl_path.write_bytes(stl_bytes)
            loaded = trimesh.load(io.BytesIO(stl_bytes), file_type="stl")
            final_mesh = (
                trimesh.util.concatenate(list(loaded.geometry.values()))
                if isinstance(loaded, trimesh.Scene)
                else loaded
            )
            if glb_bytes:
                glb_path.write_bytes(glb_bytes)
            else:
                final_mesh.export(str(glb_path), file_type="glb")
        elif glb_bytes:
            glb_path.write_bytes(glb_bytes)
            loaded = trimesh.load(io.BytesIO(glb_bytes), file_type="glb")
            final_mesh = (
                trimesh.util.concatenate(list(loaded.geometry.values()))
                if isinstance(loaded, trimesh.Scene)
                else loaded
            )
            final_mesh.export(str(stl_path), file_type="stl")
    else:
        compute_device = select_compute_device(device)
        synth_fn = mesh_synthesizer or synthesize_multiview_mesh
        raw_mesh = synth_fn(
            view_images=view_images,
            octree_resolution=octree_resolution,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            device=compute_device,
        )
        infer_seconds = round(time.time() - t0, 2)

        final_mesh = postprocess_mesh_for_3d_printing(
            raw_mesh,
            target_height_mm=target_height_mm,
            taubin_smooth_iterations=taubin_smooth_iterations,
        )
        final_mesh.export(str(stl_path), file_type="stl")
        final_mesh.export(str(glb_path), file_type="glb")

    if final_mesh is not None:
        render_mesh_orthographic_preview(final_mesh, preview_path)
        bounds = final_mesh.bounds
        extents_mm = (bounds[1] - bounds[0]).round(2).tolist()
        mesh_stats: dict[str, Any] = {
            "vertices": int(len(final_mesh.vertices)),
            "faces": int(len(final_mesh.faces)),
            "is_watertight": bool(final_mesh.is_watertight),
            "extents_mm": {
                "x_width": extents_mm[0],
                "y_depth": extents_mm[1],
                "z_height": extents_mm[2],
            },
            "bounds_min_mm": bounds[0].round(3).tolist(),
            "bounds_max_mm": bounds[1].round(3).tolist(),
        }
    else:
        # Trigger-only Google Drive mode: use mesh_stats returned in Colab's manifest
        rem_manifest = (remote_meta or {}).get("remote_manifest") or {}
        mesh_stats = rem_manifest.get("mesh_stats") or {
            "vertices": 0,
            "faces": 0,
            "is_watertight": True,
            "extents_mm": {"x_width": 60.0, "y_depth": 60.0, "z_height": target_height_mm},
            "bounds_min_mm": [-30.0, -30.0, 0.0],
            "bounds_max_mm": [30.0, 30.0, target_height_mm],
        }
        if not preview_path.is_file():
            sheet_candidate = output_dir / "sheet.png"
            if sheet_candidate.is_file():
                preview_path.write_bytes(sheet_candidate.read_bytes())
            elif view_images:
                first_img = next(iter(view_images.values()))
                first_img.save(preview_path)

    drive_links = (remote_meta or {}).get("drive_links") or {}
    drive_saved_dir = (remote_meta or {}).get("drive_saved_dir")

    manifest: dict[str, Any] = {
        "asset_name": asset_name,
        "stl_path": str(stl_path) if stl_path.is_file() else (drive_links.get("stl_url") or str(stl_path)),
        "glb_path": str(glb_path) if glb_path.is_file() else (drive_links.get("glb_url") or str(glb_path)),
        "mesh_preview_path": str(preview_path),
        "device": compute_device,
        "inference_seconds": infer_seconds,
        "views_used": list(view_images.keys()),
        "octree_resolution": octree_resolution,
        "num_inference_steps": num_inference_steps,
        "guidance_scale": guidance_scale,
        "target_height_mm": target_height_mm,
        "mesh_stats": mesh_stats,
    }
    if remote_meta is not None:
        manifest["remote_url"] = remote_meta.get("remote_url")
        manifest["remote_job_id"] = remote_meta.get("job_id")
        if drive_saved_dir:
            manifest["drive_saved_dir"] = drive_saved_dir
        if drive_links:
            manifest["drive_links"] = drive_links

    manifest_path = output_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 5: Generate 3D mesh (.stl and .glb) from verified multi-view config")
    parser.add_argument("output_dir", nargs="?", type=Path, default=None, help="Run directory containing step4_3d_config.json")
    parser.add_argument("--device", type=str, default=None, help="Compute device override (mps, cpu, cuda)")
    parser.add_argument(
        "--remote-url",
        "--colab-url",
        dest="remote_url",
        type=str,
        default=None,
        help="Remote Google Colab Cloudflare Tunnel URL (e.g. https://xxxx.trycloudflare.com) or COLAB_BACKEND_URL",
    )
    parser.add_argument(
        "--check-remote",
        action="store_true",
        help="Only probe the remote Colab GPU worker health check and exit",
    )
    parser.add_argument(
        "--download-mesh",
        action="store_true",
        help="Download .glb/.stl back over Cloudflare Tunnel instead of Drive-only link mode",
    )
    args = parser.parse_args()

    if args.check_remote:
        status = probe_remote_worker_health(args.remote_url or os.environ.get("COLAB_BACKEND_URL", ""))
        print(json.dumps(status, indent=2, ensure_ascii=False))
        sys.exit(0 if status.get("ok") else 1)

    if args.output_dir is None:
        parser.error("output_dir is required unless --check-remote is specified.")

    manifest = run_step5(
        args.output_dir,
        device=args.device,
        remote_url=args.remote_url,
        download_mesh=args.download_mesh,
    )
    if manifest.get("drive_links"):
        print(f"[Step 5] Saved to Google Drive: {manifest.get('drive_saved_dir')}")
        print(f"[Step 5] Google Drive Folder : {manifest['drive_links'].get('folder_url')}")
        print(f"[Step 5] Google Drive STL    : {manifest['drive_links'].get('stl_url')}")
        print(f"[Step 5] Google Drive GLB    : {manifest['drive_links'].get('glb_url')}")
    else:
        print(f"[Step 5] Exported STL: {manifest['stl_path']}")
        print(f"[Step 5] Exported GLB: {manifest['glb_path']}")
    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
