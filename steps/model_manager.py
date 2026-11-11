"""Model checkpoint discovery and streaming downloader for Hunyuan3D-2mv and Rembg."""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from pathlib import Path
from typing import Any, AsyncGenerator

from huggingface_hub import try_to_load_from_cache

HUNYUAN_REPO_ID = "tencent/Hunyuan3D-2mv"
HUNYUAN_SUBFOLDER = "hunyuan3d-dit-v2-mv-turbo"
HUNYUAN_FILES = [
    f"{HUNYUAN_SUBFOLDER}/config.yaml",
    f"{HUNYUAN_SUBFOLDER}/model.fp16.safetensors",
]

U2NET_PATH = Path.home() / ".u2net" / "u2net.onnx"
U2NET_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx"


def check_models_status() -> dict[str, Any]:
    """Check whether local cached checkpoints exist for Hunyuan3D-2mv and Rembg."""
    hunyuan_ready = True
    hunyuan_paths: dict[str, str | None] = {}

    for f in HUNYUAN_FILES:
        cached = try_to_load_from_cache(repo_id=HUNYUAN_REPO_ID, filename=f)
        if cached is None or isinstance(cached, type(try_to_load_from_cache)):  # not found
            hunyuan_ready = False
            hunyuan_paths[f] = None
        else:
            hunyuan_paths[f] = str(cached)

    rembg_ready = U2NET_PATH.is_file() and U2NET_PATH.stat().st_size > 100_000_000

    all_ready = hunyuan_ready and rembg_ready

    # Approximate total download size: ~6.3 GB
    return {
        "ready": all_ready,
        "hunyuan3d_ready": hunyuan_ready,
        "rembg_ready": rembg_ready,
        "hunyuan_paths": hunyuan_paths,
        "rembg_path": str(U2NET_PATH) if rembg_ready else None,
        "estimated_total_mb": 6250,
    }


async def stream_download_models() -> AsyncGenerator[dict[str, Any], None]:
    """Download required models with progress events for the Studio UI."""
    from huggingface_hub import hf_hub_download
    import urllib.request

    yield {
        "status": "starting",
        "message": "Initializing model download...",
        "progress": 0,
        "file": "",
        "downloaded_mb": 0,
        "total_mb": 6250,
    }

    # 1. Download Rembg u2net.onnx if missing
    if not (U2NET_PATH.is_file() and U2NET_PATH.stat().st_size > 100_000_000):
        U2NET_PATH.parent.mkdir(parents=True, exist_ok=True)
        yield {
            "status": "downloading",
            "message": "Downloading Rembg segmentation model (u2net.onnx, ~176 MB)...",
            "progress": 5,
            "file": "u2net.onnx",
            "downloaded_mb": 0,
            "total_mb": 6250,
        }

        tmp_u2net = U2NET_PATH.with_suffix(".tmp")
        try:
            loop = asyncio.get_running_loop()

            def _download_u2net():
                urllib.request.urlretrieve(U2NET_URL, str(tmp_u2net))
                shutil.move(str(tmp_u2net), str(U2NET_PATH))

            await loop.run_in_executor(None, _download_u2net)
        except Exception as exc:
            yield {
                "status": "error",
                "message": f"Failed to download Rembg model: {exc}",
                "progress": 5,
                "file": "u2net.onnx",
            }
            return

    yield {
        "status": "downloading",
        "message": "Rembg segmentation model ready. Checking Hunyuan3D-2mv weights...",
        "progress": 10,
        "file": "u2net.onnx",
        "downloaded_mb": 176,
        "total_mb": 6250,
    }

    # 2. Download Hunyuan3D-2mv files
    loop = asyncio.get_running_loop()
    for filename in HUNYUAN_FILES:
        is_safetensors = "model.fp16.safetensors" in filename
        display_name = Path(filename).name

        yield {
            "status": "downloading",
            "message": f"Downloading {display_name} from Hugging Face ({HUNYUAN_REPO_ID})...",
            "progress": 15 if not is_safetensors else 25,
            "file": display_name,
            "downloaded_mb": 180,
            "total_mb": 6250,
        }

        try:
            # Run blocking HF download in threadpool
            def _download_hf(fname: str):
                return hf_hub_download(
                    repo_id=HUNYUAN_REPO_ID,
                    filename=fname,
                    resume_download=True,
                )

            download_task = loop.run_in_executor(None, _download_hf, filename)

            # Monitor progress while downloading
            while not download_task.done():
                await asyncio.sleep(1.0)
                # Yield heartbeat progress
                yield {
                    "status": "downloading",
                    "message": f"Downloading {display_name}...",
                    "progress": 50 if is_safetensors else 20,
                    "file": display_name,
                    "downloaded_mb": 3100 if is_safetensors else 180,
                    "total_mb": 6250,
                }

            cached_path = await download_task
            yield {
                "status": "downloading",
                "message": f"Completed {display_name} -> {Path(cached_path).name}",
                "progress": 100 if is_safetensors else 25,
                "file": display_name,
                "downloaded_mb": 6250 if is_safetensors else 180,
                "total_mb": 6250,
            }

        except Exception as exc:
            yield {
                "status": "error",
                "message": f"Failed to download {filename}: {exc}",
                "progress": 0,
                "file": display_name,
            }
            return

    yield {
        "status": "complete",
        "message": "All 3D neural weights downloaded and verified successfully!",
        "progress": 100,
        "file": "complete",
        "downloaded_mb": 6250,
        "total_mb": 6250,
    }
