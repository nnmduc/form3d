#!/usr/bin/env python3
"""End-to-end 5-Step Modular Text-to-3D (.stl & .glb) Pipeline Runner on Mac M1 Pro."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from steps.step1_optimize_prompt import REPO_ROOT, run_step1, sanitize_slug
from steps.step2_generate_image import run_step2
from steps.step3_process_image import run_step3
from steps.step4_optimize_3d import run_step4
from steps.step5_generate_mesh import run_step5


def run_pipeline(
    user_prompt: str,
    output_dir: Path | None = None,
    from_step: int = 1,
    to_step: int = 5,
    device: str | None = None,
    remote_url: str | None = None,
) -> dict[str, Any]:
    """Run the 5-step Text-to-3D workflow from `from_step` through `to_step`.

    Steps:
        1. `agy` Prompt Optimizer (Text -> 3D Design Spec & 2x2 Turnaround Prompt)
        2. `agy` Image Generator (2x2 Orthographic Turnaround Sheet `sheet.png`)
        3. Python Image Processor (Slice 2x2 + `rembg` RGBA + OpenCV Alpha Filter)
        4. `agy` Multimodal View Verification & 3D Hyperparameter Optimizer
        5. Local `Hunyuan3D-2mv` (MPS) -> Z-up 80mm `.stl` & `.glb` Export
    """
    if not (1 <= from_step <= to_step <= 5):
        raise ValueError(f"Invalid step range: from_step={from_step}, to_step={to_step} (must be within 1..5)")

    t_start = time.time()
    step1_data: dict[str, Any] | None = None
    step2_data: dict[str, Any] | None = None
    step3_data: dict[str, Any] | None = None
    step4_data: dict[str, Any] | None = None
    manifest: dict[str, Any] | None = None

    # Step 1: Optimize Prompt
    if from_step <= 1 <= to_step:
        print(f"\n=== [Step 1/5] Optimizing prompt via `agy` for: {user_prompt!r} ===")
        output_dir, step1_data = run_step1(user_prompt, output_dir=output_dir)
        print(f" -> Asset slug: {step1_data['asset_name']}")
        print(f" -> Saved: {output_dir / 'step1_prompt.json'}")
    else:
        if output_dir is None:
            slug = sanitize_slug(user_prompt.replace("Generate ", "").replace("generate ", ""))
            candidate = REPO_ROOT / "outputs" / slug
            if candidate.is_dir():
                output_dir = candidate
            else:
                # Search existing outputs/*/step1_prompt.json
                matches = list((REPO_ROOT / "outputs").glob("*/step1_prompt.json"))
                if len(matches) == 1:
                    output_dir = matches[0].parent
                else:
                    raise FileNotFoundError(
                        f"When starting from --from-step {from_step}, please specify --output-dir "
                        f"(could not automatically resolve {candidate})."
                    )
        output_dir = output_dir.resolve()

    assert output_dir is not None

    # Step 2: Generate 2x2 Turnaround Sheet
    if from_step <= 2 <= to_step:
        print(f"\n=== [Step 2/5] Generating 2x2 orthographic turnaround sheet via `agy` (image-generator) ===")
        step2_data = run_step2(output_dir, step1_data=step1_data)
        print(f" -> Saved turnaround sheet: {step2_data['sheet_image_path']}")

    # Step 3: Slice 2x2 Quadrant Tiles + rembg + OpenCV Alpha Cleanup
    if from_step <= 3 <= to_step:
        print(f"\n=== [Step 3/5] Slicing 2x2 quadrants + removing background + cleaning alpha masks ===")
        step3_data = run_step3(output_dir, step2_data=step2_data)
        for tile_name, meta in step3_data["tiles"].items():
            print(
                f" -> {tile_name} (expected {meta['expected_view']}): "
                f"coverage={meta['coverage_ratio']*100:.1f}%, kept_components={meta['components_kept']}/{meta['components_total']}"
            )

    # Step 4: Multimodal View Verification & 3D Config Optimization via `agy`
    if from_step <= 4 <= to_step:
        print(f"\n=== [Step 4/5] Verifying views & optimizing 3D config via `agy` ===")
        step4_data = run_step4(output_dir, step1_data=step1_data, step3_data=step3_data)
        print(f" -> Verified views: {list(step4_data['view_mapping'].keys())}")
        print(
            f" -> 3D params: octree={step4_data['octree_resolution']}, "
            f"steps={step4_data['num_inference_steps']}, guidance={step4_data['guidance_scale']}, "
            f"height={step4_data['target_height_mm']}mm"
        )
        print(f" -> QA notes: {step4_data['qa_notes']}")

    # Step 5: 3D Mesh Generation (Local MPS or Remote Colab GPU) & STL/GLB Export
    if from_step <= 5 <= to_step:
        print(f"\n=== [Step 5/5] Synthesizing 3D mesh (`tencent/Hunyuan3D-2mv`) & exporting .stl / .glb ===")
        manifest = run_step5(output_dir, step4_data=step4_data, device=device, remote_url=remote_url)
        stats = manifest["mesh_stats"]
        print(f" -> STL: {manifest['stl_path']}")
        print(f" -> GLB: {manifest['glb_path']}")
        print(
            f" -> Geometry: {stats['vertices']} vertices, {stats['faces']} faces, "
            f"watertight={stats['is_watertight']}, size={stats['extents_mm']} mm"
        )

    total_sec = round(time.time() - t_start, 2)
    print(f"\n=== Pipeline finished (steps {from_step}..{to_step}) in {total_sec}s — outputs in {output_dir} ===")
    return {
        "output_dir": str(output_dir),
        "from_step": from_step,
        "to_step": to_step,
        "total_seconds": total_sec,
        "manifest": manifest,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the 5-step modular Text-to-3D (.stl & .glb) pipeline on Mac M1 Pro"
    )
    parser.add_argument(
        "prompt",
        nargs="?",
        default="Generate a cute robot",
        help="User text prompt (default: 'Generate a cute robot')",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Explicit output directory (default: outputs/<asset_name>)",
    )
    parser.add_argument(
        "--from-step",
        type=int,
        default=1,
        choices=[1, 2, 3, 4, 5],
        help="Step number to start/resume from (1..5)",
    )
    parser.add_argument(
        "--to-step",
        type=int,
        default=5,
        choices=[1, 2, 3, 4, 5],
        help="Step number to stop at (1..5)",
    )
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="Compute device override for Step 5 (mps, cpu, cuda)",
    )
    parser.add_argument(
        "--remote-url",
        "--colab-url",
        dest="remote_url",
        type=str,
        default=None,
        help="Remote Google Colab Cloudflare Tunnel URL for Step 5 mesh synthesis",
    )
    args = parser.parse_args()

    summary = run_pipeline(
        user_prompt=args.prompt,
        output_dir=args.output_dir,
        from_step=args.from_step,
        to_step=args.to_step,
        device=args.device,
        remote_url=args.remote_url,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
