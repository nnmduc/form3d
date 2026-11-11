"""Step 3: Pure Python 2x2 Quadrant Cutter + Background Remover + OpenCV Alpha Connected-Component Cleaner."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
from PIL import Image


def clean_alpha_keep_main_subject(
    rgba_img: Image.Image,
    min_secondary_ratio: float = 0.08,
    alpha_threshold: int = 20,
) -> tuple[Image.Image, dict[str, Any]]:
    """Strip disconnected corner text labels, grid lines, or noise specks from an RGBA tile.

    Keeps the largest foreground connected component around the tile center, plus any secondary
    component that is both substantial (>= `min_secondary_ratio` of largest component area) and
    not touching the outer 2% border.

    Args:
        rgba_img: Input RGBA PIL Image.
        min_secondary_ratio: Minimum area ratio relative to the largest component to retain.
        alpha_threshold: Alpha value threshold (0-255) for binary connected-components analysis.

    Returns:
        Tuple of `(cleaned_rgba_image, stats_dict)`.
    """
    arr = np.array(rgba_img.convert("RGBA"), copy=True)
    h, w = arr.shape[:2]
    alpha = arr[:, :, 3]
    binary = (alpha > alpha_threshold).astype(np.uint8)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if num_labels <= 1:
        return Image.fromarray(arr), {
            "foreground_pixels": 0,
            "coverage_ratio": 0.0,
            "components_total": 0,
            "components_kept": 0,
            "bbox": [0, 0, w, h],
        }

    # Component 0 is background; inspect components 1..num_labels-1
    areas = stats[1:, cv2.CC_STAT_AREA]
    largest_idx = int(np.argmax(areas)) + 1
    largest_area = int(stats[largest_idx, cv2.CC_STAT_AREA])

    keep_mask = np.zeros_like(alpha, dtype=bool)
    kept_count = 0
    border_margin_x = max(2, int(w * 0.015))
    border_margin_y = max(2, int(h * 0.015))

    for comp_id in range(1, num_labels):
        comp_area = int(stats[comp_id, cv2.CC_STAT_AREA])
        x = int(stats[comp_id, cv2.CC_STAT_LEFT])
        y = int(stats[comp_id, cv2.CC_STAT_TOP])
        cw = int(stats[comp_id, cv2.CC_STAT_WIDTH])
        ch = int(stats[comp_id, cv2.CC_STAT_HEIGHT])

        touches_border = (
            x <= border_margin_x
            or y <= border_margin_y
            or (x + cw) >= (w - border_margin_x)
            or (y + ch) >= (h - border_margin_y)
        )

        if comp_id == largest_idx or (comp_area >= largest_area * min_secondary_ratio and not touches_border):
            keep_mask |= labels == comp_id
            kept_count += 1

    arr[:, :, 3] = np.where(keep_mask, alpha, 0)
    # Zero out RGB on transparent pixels to avoid color fringes during interpolation
    transparent = arr[:, :, 3] == 0
    arr[transparent, :3] = 255

    ys, xs = np.nonzero(arr[:, :, 3] > alpha_threshold)
    if len(xs) > 0 and len(ys) > 0:
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    else:
        bbox = [0, 0, w, h]

    fg_pixels = int(np.count_nonzero(arr[:, :, 3] > alpha_threshold))
    return Image.fromarray(arr), {
        "foreground_pixels": fg_pixels,
        "coverage_ratio": round(fg_pixels / float(w * h), 4),
        "components_total": int(num_labels - 1),
        "components_kept": kept_count,
        "bbox": bbox,
    }


def default_background_remover() -> Callable[[Image.Image], Image.Image]:
    """Create the background remover callable (`hy3dgen.rembg.BackgroundRemover` or `rembg.remove`)."""
    try:
        from hy3dgen.rembg import BackgroundRemover

        remover = BackgroundRemover()
        return lambda img: remover(img.convert("RGB"))
    except Exception:
        from rembg import remove

        return lambda img: remove(img.convert("RGB"))


def slice_and_clean_2x2_sheet(
    sheet_path: Path,
    tiles_dir: Path,
    trim_ratio: float = 0.02,
    bg_remover: Callable[[Image.Image], Image.Image] | None = None,
) -> dict[str, Any]:
    """Slice a 2x2 turnaround sheet into 4 quadrants, remove background, and sanitize alpha masks.

    Args:
        sheet_path: Path to the 2x2 turnaround sheet image (`sheet.png`).
        tiles_dir: Directory where `tile_tl.png`, `tile_tr.png`, `tile_bl.png`, `tile_br.png` are saved.
        trim_ratio: Fraction of each quadrant's width/height to trim inward from all 4 edges (default 0.02).
        bg_remover: Optional callable `(PIL.Image) -> PIL.Image (RGBA)`. Defaults to `hy3dgen`/`rembg`.

    Returns:
        Dictionary summarizing the 4 processed tiles (`tiles` mapping + metadata).
    """
    sheet_path = sheet_path.resolve()
    if not sheet_path.is_file():
        raise FileNotFoundError(f"Turnaround sheet not found: {sheet_path}")

    tiles_dir = tiles_dir.resolve()
    tiles_dir.mkdir(parents=True, exist_ok=True)

    if bg_remover is None:
        bg_remover = default_background_remover()

    sheet = Image.open(sheet_path).convert("RGBA")
    w, h = sheet.size
    mid_x, mid_y = w // 2, h // 2
    dx = int(mid_x * trim_ratio)
    dy = int(mid_y * trim_ratio)

    quadrant_boxes = {
        "tile_tl": (dx, dy, mid_x - dx, mid_y - dy),
        "tile_tr": (mid_x + dx, dy, w - dx, mid_y - dy),
        "tile_bl": (dx, mid_y + dy, mid_x - dx, h - dy),
        "tile_br": (mid_x + dx, mid_y + dy, w - dx, h - dy),
    }
    expected_views = {
        "tile_tl": "front",
        "tile_tr": "left",
        "tile_bl": "back",
        "tile_br": "right",
    }

    tiles_meta: dict[str, Any] = {}
    for tile_key, box in quadrant_boxes.items():
        crop = sheet.crop(box)
        # If crop already has a clean alpha channel (e.g. synthetic test), preserve or combine with bg_remover
        rgba = bg_remover(crop)
        if not isinstance(rgba, Image.Image):
            rgba = Image.fromarray(rgba)
        rgba = rgba.convert("RGBA")

        cleaned, stats = clean_alpha_keep_main_subject(rgba)
        out_path = tiles_dir / f"{tile_key}.png"
        cleaned.save(out_path)

        tiles_meta[tile_key] = {
            "path": str(out_path),
            "expected_view": expected_views[tile_key],
            "crop_box": list(box),
            "size": list(cleaned.size),
            **stats,
        }

    return {
        "sheet_image_path": str(sheet_path),
        "sheet_size": [w, h],
        "trim_ratio": trim_ratio,
        "tiles": tiles_meta,
    }


def run_step3(
    output_dir: Path,
    step2_data: dict[str, Any] | None = None,
    trim_ratio: float = 0.02,
    bg_remover: Callable[[Image.Image], Image.Image] | None = None,
) -> dict[str, Any]:
    """Execute Step 3 (slice 2x2 sheet + rembg + OpenCV alpha cleanup) and write `step3_tiles.json`."""
    output_dir = output_dir.resolve()
    if step2_data is None:
        step2_path = output_dir / "step2_image.json"
        if step2_path.is_file():
            with open(step2_path, "r", encoding="utf-8") as f:
                step2_data = json.load(f)
        else:
            step2_data = {"sheet_image_path": str(output_dir / "sheet.png")}

    sheet_path = Path(step2_data["sheet_image_path"]).expanduser().resolve()
    tiles_dir = output_dir / "tiles"

    result = slice_and_clean_2x2_sheet(
        sheet_path=sheet_path,
        tiles_dir=tiles_dir,
        trim_ratio=trim_ratio,
        bg_remover=bg_remover,
    )

    artifact_path = output_dir / "step3_tiles.json"
    with open(artifact_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Step 3: Slice 2x2 sheet and clean RGBA tiles")
    parser.add_argument("output_dir", type=Path, help="Run directory containing sheet.png")
    parser.add_argument("--trim-ratio", type=float, default=0.02, help="Edge trim ratio per quadrant (default: 0.02)")
    args = parser.parse_args()

    data = run_step3(args.output_dir, trim_ratio=args.trim_ratio)
    print(f"[Step 3] Processed 4 RGBA tiles in {args.output_dir / 'tiles'}")
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
