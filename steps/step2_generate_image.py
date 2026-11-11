"""Step 2: Generate the 1024x1024 2x2 orthographic turnaround sheet via `agy` (image-generator subagent)."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from steps.agy_runner import AgyExecutionError, run_agy_json

DEFAULT_SCHEMA_PATH = REPO_ROOT / "schemas" / "step2_image_gen.schema.json"


def build_step2_prompt(step1_data: dict[str, Any], target_sheet_path: Path) -> str:
    """Build the prompt instructing `agy` to invoke `image-generator` and save `sheet.png`."""
    turnaround_prompt = step1_data["turnaround_image_prompt"]
    design_spec = step1_data["character_design_spec"]
    negative = step1_data["negative_constraints"]

    return f"""Use the `image-generator` subagent (`invoke_subagent` with `TypeName: "image-generator"`) to generate ONE square 1:1 (1024x1024) 2x2 orthographic turnaround reference sheet PNG image, then copy/save that image to the exact path:
`{target_sheet_path}`

Pass the following detailed brief to `image-generator`:

---
CHARACTER DESIGN SPECIFICATION:
{design_spec}

IMAGE GENERATION PROMPT (2x2 ORTHOGRAPHIC TURNAROUND SHEET):
{turnaround_prompt}

STRICT LAYOUT & CLEANLINESS RULES:
- Single 1:1 square image divided invisibly into 4 equal quadrants (2x2 grid):
  * Top-Left quadrant: strict orthographic FRONT view (facing straight at camera).
  * Top-Right quadrant: strict orthographic LEFT profile view (90-degree side view).
  * Bottom-Left quadrant: strict orthographic BACK view (180-degree rear view).
  * Bottom-Right quadrant: strict orthographic RIGHT profile view (270-degree side view).
- Keep the character's height, proportions, and design 100% identical across all 4 views.
- Leave at least 15% pure white margin around the character inside every quadrant so nothing is clipped or touching the center axes.
- Pure solid flat white (#FFFFFF) background, even matte studio clay/toy lighting, NO cast shadows on the floor.
- AVOID / NEGATIVE CONSTRAINTS: {negative}
---

After `image-generator` finishes and returns the saved image file path:
- Immediately return the JSON response with `"sheet_image_path"` set to the exact absolute file path returned by `image-generator` (or `{target_sheet_path}` if you copied it there) and `"status": "ok"`. Python will automatically copy the file to `{target_sheet_path}` if needed.
"""


def run_step2(
    output_dir: Path,
    step1_data: dict[str, Any] | None = None,
    schema_path: Path = DEFAULT_SCHEMA_PATH,
) -> dict[str, Any]:
    """Execute Step 2 (`agy` image generation) and save `sheet.png` + `step2_image.json`.

    Args:
        output_dir: Run directory (`outputs/<slug>`).
        step1_data: Optional parsed `step1_prompt.json` dict. Loaded from `output_dir` if None.
        schema_path: Path to `step2_image_gen.schema.json`.

    Returns:
        Validated `step2_image.json` dictionary.
    """
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if step1_data is None:
        step1_path = output_dir / "step1_prompt.json"
        if not step1_path.is_file():
            raise FileNotFoundError(f"Missing Step 1 artifact: {step1_path}")
        with open(step1_path, "r", encoding="utf-8") as f:
            step1_data = json.load(f)

    target_sheet_path = (output_dir / "sheet.png").resolve()
    prompt = build_step2_prompt(step1_data, target_sheet_path)

    result = run_agy_json(
        prompt=prompt,
        schema_path=schema_path,
        workspace_dir=REPO_ROOT,
        extra_dirs=[output_dir],
        timeout_sec=600,
    )

    returned_path = Path(result.get("sheet_image_path", "")).expanduser()
    if not target_sheet_path.is_file():
        if returned_path.is_file():
            shutil.copyfile(returned_path, target_sheet_path)
        else:
            raise AgyExecutionError(
                f"Step 2 completed with status={result.get('status')}, but neither "
                f"{target_sheet_path} nor {returned_path} exists on disk."
            )

    result["sheet_image_path"] = str(target_sheet_path)
    result["status"] = "ok"

    artifact_path = output_dir / "step2_image.json"
    with open(artifact_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 2: Generate 2x2 turnaround sheet via agy image-generator")
    parser.add_argument("output_dir", type=Path, help="Run directory containing step1_prompt.json")
    args = parser.parse_args()

    data = run_step2(args.output_dir)
    print(f"[Step 2] Saved turnaround sheet to {data['sheet_image_path']}")
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
