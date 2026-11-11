"""Step 4: Multimodal View Verification & 3D Hyperparameter/Prompt Optimization via `agy`."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from steps.agy_runner import AgyExecutionError, run_agy_json

DEFAULT_SCHEMA_PATH = REPO_ROOT / "schemas" / "step4_3d_config.schema.json"


def build_step4_prompt(
    step1_data: dict[str, Any],
    step3_data: dict[str, Any],
) -> str:
    """Build the multimodal QA and 3D config optimization prompt for Step 4."""
    tiles = step3_data["tiles"]
    tile_lines = "\n".join(
        f"- `{k}` (expected `{v['expected_view']}`, coverage={v['coverage_ratio']}): `{v['path']}`"
        for k, v in tiles.items()
    )

    return f"""You are a 3D Reconstruction Vision QA & Hyperparameter Optimizer preparing multi-view inputs for Tencent `Hunyuan3D-2mv` (`hunyuan3d-dit-v2-mv-turbo`) on Apple Silicon (M1 Pro).

Character Design Specification (from Step 1):
{step1_data.get('character_design_spec', '')}

Processed RGBA Quadrant Tiles (from Step 3):
{tile_lines}

INSTRUCTIONS:
1. Use the `read_file` tool to visually inspect all 4 RGBA tile PNG files listed above (`tile_tl.png`, `tile_tr.png`, `tile_bl.png`, `tile_br.png`).
2. Verify the TRUE camera angle of each tile (`front`, `left`, `back`, `right`):
   - Image generators sometimes swap `left` and `right`, or swap `top_right` (`left`) with `bottom_left` (`back`).
   - Map each valid camera view (`front`, and optionally `left`, `back`, `right`) in `view_mapping` to the exact absolute PNG file path that genuinely shows that view.
   - If a tile is severely corrupted, empty, or shows a duplicate angle that contradicts another cleaner view, omit that view key from `view_mapping` (`front` is required).
3. Generate `mesh_3d_prompt`: A concise, high-precision 3D geometry & surface description of the character mesh for downstream 3D metadata and conditioning.
4. Select optimal `Hunyuan3D-2mv` reconstruction parameters based on the visual complexity of the character:
   - `octree_resolution`: `256` (fast/smooth chibi shapes), `320` (balanced detail, recommended default for M1 Pro), or `380` (fine mechanical/articulated details).
   - `num_inference_steps`: between `5` and `30` (`8` to `12` is ideal for `hunyuan3d-dit-v2-mv-turbo`).
   - `guidance_scale`: between `3.0` and `10.0` (`5.0` to `6.0` recommended).
   - `target_height_mm`: `80.0` (standard desktop figurine height in millimeters).
   - `taubin_smooth_iterations`: `0` to `5` (`2` is recommended to smooth marching-cubes stair-stepping without shrinking features).
   - `qa_notes`: Summarize what you observed in each of the 4 tiles (`tile_tl`, `tile_tr`, `tile_bl`, `tile_br`) and explain any view remapping or hyperparameter choices.
"""


def run_step4(
    output_dir: Path,
    step1_data: dict[str, Any] | None = None,
    step3_data: dict[str, Any] | None = None,
    schema_path: Path = DEFAULT_SCHEMA_PATH,
) -> dict[str, Any]:
    """Execute Step 4 (`agy` multimodal view verification + 3D config optimizer) and save `step4_3d_config.json`."""
    output_dir = output_dir.resolve()
    if step1_data is None:
        with open(output_dir / "step1_prompt.json", "r", encoding="utf-8") as f:
            step1_data = json.load(f)
    if step3_data is None:
        with open(output_dir / "step3_tiles.json", "r", encoding="utf-8") as f:
            step3_data = json.load(f)

    prompt = build_step4_prompt(step1_data, step3_data)
    result = run_agy_json(
        prompt=prompt,
        schema_path=schema_path,
        workspace_dir=REPO_ROOT,
        extra_dirs=[output_dir],
        timeout_sec=300,
    )

    view_mapping = result.get("view_mapping", {})
    if "front" not in view_mapping:
        raise AgyExecutionError("Step 4 `view_mapping` must include at least the `front` view.")

    verified_mapping: dict[str, str] = {}
    for view_key, img_path_str in view_mapping.items():
        if not img_path_str:
            continue
        img_path = Path(img_path_str).expanduser()
        if not img_path.is_absolute():
            img_path = (output_dir / img_path).resolve()
        if not img_path.is_file():
            raise AgyExecutionError(f"Step 4 mapped view '{view_key}' to non-existent file: {img_path}")
        verified_mapping[view_key] = str(img_path)

    result["view_mapping"] = verified_mapping

    artifact_path = output_dir / "step4_3d_config.json"
    with open(artifact_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 4: Verify 4 views and optimize 3D config via agy")
    parser.add_argument("output_dir", type=Path, help="Run directory containing step1_prompt.json and step3_tiles.json")
    args = parser.parse_args()

    data = run_step4(args.output_dir)
    print(f"[Step 4] Saved verified 3D config to {args.output_dir / 'step4_3d_config.json'}")
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
