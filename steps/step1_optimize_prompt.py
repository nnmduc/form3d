"""Step 1: Optimize raw user prompt into a 3D-printable character spec and 2x2 turnaround image prompt via `agy`."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from steps.agy_runner import run_agy_json

DEFAULT_SCHEMA_PATH = REPO_ROOT / "schemas" / "step1_image_prompt.schema.json"


def sanitize_slug(slug: str) -> str:
    """Normalize an asset_name into a clean snake_case folder slug."""
    cleaned = re.sub(r"[^a-z0-9]+", "_", slug.strip().lower()).strip("_")
    return cleaned or "model_3d"


def build_step1_prompt(user_prompt: str) -> str:
    """Construct the optimization prompt sent to `agy` in Step 1."""
    stripped = re.sub(r"^generate\s+(a\s+|an\s+)?", "", user_prompt.strip(), flags=re.IGNORECASE)
    suggested_slug = sanitize_slug(stripped)
    return f"""You are a 3D Character & Toy Design Engineer preparing a specification for multi-view 2D-to-3D reconstruction (Tencent Hunyuan3D-2mv) and FDM 3D printing (.stl).

Raw User Request: "{user_prompt}"

Do NOT call any tools or subagents. Directly synthesize a structured JSON response that optimizes this request for 3D reconstruction and 3D printing:

1. `asset_name`: Use `{suggested_slug}` as the concise snake_case identifier.
2. `character_design_spec`: Detailed geometric and physical design specification optimized for 3D printing:
   - Compact, sturdy, self-supporting proportions (thick manifold limbs, connected joints, flat stable feet or base contact).
   - Zero floating parts, zero paper-thin wires or fragile antennae.
   - Explicit, unambiguous visual landmarks differentiating the FRONT (e.g., face/visor/chest panel), LEFT profile, BACK (e.g., power pack/exhaust vents/spine detail), and RIGHT profile so that all 4 orthographic views can be visually identified and aligned.
3. `turnaround_image_prompt`: A complete, self-contained image generation prompt for creating a single square 1:1 (1024x1024) 2x2 orthographic turnaround reference sheet with these exact rules:
   - Exact 2x2 Quadrant Layout:
     * Top-Left quadrant: strict orthographic FRONT view (facing straight toward the camera, 0 degrees).
     * Top-Right quadrant: strict orthographic LEFT profile view (90-degree side view, character facing left).
     * Bottom-Left quadrant: strict orthographic BACK view (180-degree rear view, showing back landmarks).
     * Bottom-Right quadrant: strict orthographic RIGHT profile view (270-degree side view, character facing right).
   - Identical character geometry, exact same height, scale, and symmetric standing A-pose across all 4 quadrants.
   - Well-centered inside each quadrant with at least 15% empty white margin around the silhouette so no part touches quadrant boundaries.
   - Pure solid flat white (#FFFFFF) background everywhere, soft even studio matte clay/vinyl-toy lighting, NO cast floor shadows, NO ground plane or pedestal.
   - ZERO text labels (do not write "Front", "Back", "Left", "Right"), ZERO dividing grid lines, ZERO borders or watermarks.
4. `negative_constraints`: Comma-separated list of elements that must not appear in the turnaround sheet (text labels, typography, grid lines, dividing borders, cast shadows, pedestals, thin wires, floating parts, perspective distortion).
"""


def run_step1(
    user_prompt: str,
    output_dir: Path | None = None,
    schema_path: Path = DEFAULT_SCHEMA_PATH,
) -> tuple[Path, dict[str, Any]]:
    """Execute Step 1 (`agy` prompt optimizer) and save `step1_prompt.json`.

    Args:
        user_prompt: Raw user text prompt (e.g. "Generate a cute robot").
        output_dir: Optional target output directory. Defaults to `outputs/<asset_name>`.
        schema_path: Path to `step1_image_prompt.schema.json`.

    Returns:
        Tuple of `(resolved_output_dir, step1_data)`.
    """
    prompt = build_step1_prompt(user_prompt)
    result = run_agy_json(
        prompt=prompt,
        schema_path=schema_path,
        workspace_dir=REPO_ROOT,
    )

    result["asset_name"] = sanitize_slug(result.get("asset_name", "cute_robot"))
    if output_dir is None:
        output_dir = REPO_ROOT / "outputs" / result["asset_name"]
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    artifact_path = output_dir / "step1_prompt.json"
    with open(artifact_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    return output_dir, result


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 1: Optimize user prompt for 3D turnaround image generation")
    parser.add_argument("prompt", help="Raw user prompt, e.g. 'Generate a cute robot'")
    parser.add_argument("--output-dir", type=Path, default=None, help="Output directory (default: outputs/<asset_name>)")
    args = parser.parse_args()

    out_dir, data = run_step1(args.prompt, output_dir=args.output_dir)
    print(f"[Step 1] Saved optimized prompt spec to {out_dir / 'step1_prompt.json'}")
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
