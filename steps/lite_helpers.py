"""Lite Mode Backend Helpers: Smart CV Analysis, Auto-Calibration, Slicing & 3D Config for Form 3D."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

from steps.step3_process_image import clean_alpha_keep_main_subject, default_background_remover


def analyze_turnaround_sheet(sheet_path: Path | str) -> dict[str, Any]:
    """Analyze a user-provided 2x2 turnaround sheet image using computer vision.

    Detects:
    - Dimensions & aspect ratio
    - Optimal split crosshairs (searching for gutter valleys)
    - Foreground subject bounds in each quadrant
    - Height consistency across the 4 views
    - Background cleanliness (white check)
    - Actionable recommendations for the user
    """
    path = Path(sheet_path).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Turnaround sheet not found: {path}")

    pil_img = Image.open(path).convert("RGB")
    width, height = pil_img.size
    img_np = np.array(pil_img)

    aspect_ratio = round(width / float(height), 3)
    is_square = abs(aspect_ratio - 1.0) <= 0.05

    # Convert to grayscale & binarize foreground
    gray = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)

    # Detect background color near borders
    border_pixels = np.concatenate([
        gray[:5, :].flatten(),
        gray[-5:, :].flatten(),
        gray[:, :5].flatten(),
        gray[:, -5:].flatten(),
    ])
    mean_border_val = float(np.mean(border_pixels))
    is_white_bg = mean_border_val >= 235.0

    # Binary mask of foreground (assuming light/white background)
    if is_white_bg:
        _, fg_mask = cv2.threshold(gray, 242, 255, cv2.THRESH_BINARY_INV)
    else:
        # Fallback adaptive threshold / Otsu
        _, fg_mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Morphological opening to remove salt noise
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, kernel)

    # Find optimal split crosshair: examine gutter valleys around 35%-65% of width and height
    mid_x_range = (int(width * 0.35), int(width * 0.65))
    mid_y_range = (int(height * 0.35), int(height * 0.65))

    col_sums = np.sum(fg_mask[:, mid_x_range[0] : mid_x_range[1]], axis=0)
    row_sums = np.sum(fg_mask[mid_y_range[0] : mid_y_range[1], :], axis=1)

    # Optimal center X & Y is the midpoint of the valley (minimum foreground sum)
    min_col_val = np.min(col_sums)
    min_col_indices = np.where(col_sums == min_col_val)[0]
    best_local_cx = int(min_col_indices[len(min_col_indices) // 2])
    best_cx = mid_x_range[0] + best_local_cx
    suggested_center_x = round(best_cx / float(width), 3)

    min_row_val = np.min(row_sums)
    min_row_indices = np.where(row_sums == min_row_val)[0]
    best_local_cy = int(min_row_indices[len(min_row_indices) // 2])
    best_cy = mid_y_range[0] + best_local_cy
    suggested_center_y = round(best_cy / float(height), 3)

    # If the detected valley has non-zero density or is close to 0.5, snap to 0.5 if difference < 2%
    if abs(suggested_center_x - 0.5) < 0.025:
        suggested_center_x = 0.5
        best_cx = width // 2

    if abs(suggested_center_y - 0.5) < 0.025:
        suggested_center_y = 0.5
        best_cy = height // 2

    # Measure foreground subject in each quadrant
    quadrant_coords = {
        "tile_tl": (0, 0, best_cx, best_cy),
        "tile_tr": (best_cx, 0, width, best_cy),
        "tile_bl": (0, best_cy, best_cx, height),
        "tile_br": (best_cx, best_cy, width, height),
    }

    quadrants_info: dict[str, Any] = {}
    heights: list[int] = []

    for q_name, (x1, y1, x2, y2) in quadrant_coords.items():
        q_mask = fg_mask[y1:y2, x1:x2]
        ys, xs = np.nonzero(q_mask > 0)
        qw = x2 - x1
        qh = y2 - y1

        if len(ys) > 50 and len(xs) > 50:
            ymin, ymax = int(ys.min()), int(ys.max())
            xmin, xmax = int(xs.min()), int(xs.max())
            sub_h = ymax - ymin
            sub_w = xmax - xmin
            heights.append(sub_h)
            quadrants_info[q_name] = {
                "bbox": [x1 + xmin, y1 + ymin, x1 + xmax, y1 + ymax],
                "local_bbox": [xmin, ymin, xmax, ymax],
                "subject_height": sub_h,
                "subject_width": sub_w,
                "coverage_pct": round(float(len(ys)) / float(qw * qh) * 100, 1),
                "has_subject": True,
            }
        else:
            quadrants_info[q_name] = {
                "bbox": [x1, y1, x2, y2],
                "local_bbox": [0, 0, qw, qh],
                "subject_height": 0,
                "subject_width": 0,
                "coverage_pct": 0.0,
                "has_subject": False,
            }

    # Evaluate consistency
    warnings: list[str] = []
    consistency_score = 100

    if not is_square:
        warnings.append(
            f"Ảnh chưa chuẩn vuông 1:1 ({width}x{height}, tỉ lệ {aspect_ratio}). Hệ thống sẽ tự động căn giữa và đệm viền."
        )
        consistency_score -= 15

    if not is_white_bg:
        warnings.append(
            f"Màu nền viền chưa phải màu trắng thuần (độ sáng trung bình {int(mean_border_val)}/255). Tách nền có thể cần lọc kỹ hơn."
        )
        consistency_score -= 10

    if len(heights) == 4 and all(h > 0 for h in heights):
        avg_h = float(np.mean(heights))
        max_h = max(heights)
        min_h = min(heights)
        diff_ratio = (max_h - min_h) / avg_h if avg_h > 0 else 0

        if diff_ratio > 0.18:
            warnings.append(
                f"Chiều cao giữa các góc nhìn có sự chênh lệch {int(diff_ratio * 100)}% (Cao nhất: {max_h}px, Thấp nhất: {min_h}px). "
                "Bạn nên bật tùy chọn 'Tự động cân bằng tỉ lệ chiều cao' để mô hình 3D chuẩn xác nhất."
            )
            consistency_score -= int(diff_ratio * 50)
    elif len(heights) < 4:
        warnings.append("Một số góc nhìn dường như không có chủ thể rõ ràng hoặc bị mờ nhạt.")
        consistency_score -= 30

    consistency_score = max(20, min(100, consistency_score))

    return {
        "width": width,
        "height": height,
        "aspect_ratio": aspect_ratio,
        "is_square": is_square,
        "is_white_bg": is_white_bg,
        "mean_border_brightness": round(mean_border_val, 1),
        "suggested_center_x": suggested_center_x,
        "suggested_center_y": suggested_center_y,
        "quadrants": quadrants_info,
        "height_consistency_score": consistency_score,
        "warnings": warnings,
    }


def slice_and_clean_lite(
    sheet_path: Path | str,
    output_dir: Path | str,
    center_x_ratio: float = 0.5,
    center_y_ratio: float = 0.5,
    trim_ratio: float = 0.02,
    auto_normalize_heights: bool = True,
) -> dict[str, Any]:
    """Slice a 2x2 turnaround sheet into 4 tiles, remove background, clean alpha masks,

    and optionally normalize heights/baselines for optimal 3D synthesis.
    """
    path = Path(sheet_path).resolve()
    out_dir = Path(output_dir).resolve()
    tiles_dir = out_dir / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)

    sheet_img = Image.open(path).convert("RGBA")
    w, h = sheet_img.size

    # Split lines
    split_x = max(int(w * 0.2), min(int(w * 0.8), int(w * center_x_ratio)))
    split_y = max(int(h * 0.2), min(int(h * 0.8), int(h * center_y_ratio)))

    dx1 = int(split_x * trim_ratio)
    dx2 = int((w - split_x) * trim_ratio)
    dy1 = int(split_y * trim_ratio)
    dy2 = int((h - split_y) * trim_ratio)

    boxes = {
        "tile_tl": (dx1, dy1, split_x - dx1, split_y - dy1),
        "tile_tr": (split_x + dx2, dy1, w - dx2, split_y - dy1),
        "tile_bl": (dx1, split_y + dy2, split_x - dx1, h - dy2),
        "tile_br": (split_x + dx2, split_y + dy2, w - dx2, h - dy2),
    }

    views = {
        "tile_tl": "front",
        "tile_tr": "left",
        "tile_bl": "back",
        "tile_br": "right",
    }

    bg_remover = default_background_remover()
    raw_cleaned_tiles: dict[str, tuple[Image.Image, dict[str, Any]]] = {}

    for q_key, box in boxes.items():
        crop = sheet_img.crop(box)
        rgba = bg_remover(crop)
        if not isinstance(rgba, Image.Image):
            rgba = Image.fromarray(rgba)
        rgba = rgba.convert("RGBA")

        cleaned, stats = clean_alpha_keep_main_subject(rgba)
        raw_cleaned_tiles[q_key] = (cleaned, stats)

    # Optional Height Normalization & Baseline Alignment
    if auto_normalize_heights:
        # Calculate subject height in each cleaned tile
        subject_heights = []
        for q_key, (img, stats) in raw_cleaned_tiles.items():
            bbox = stats.get("bbox", [0, 0, img.width, img.height])
            sh = bbox[3] - bbox[1]
            if sh > 30:
                subject_heights.append(sh)

        if len(subject_heights) >= 2:
            target_h = int(np.median(subject_heights))
            for q_key, (img, stats) in raw_cleaned_tiles.items():
                bbox = stats.get("bbox", [0, 0, img.width, img.height])
                cur_h = bbox[3] - bbox[1]
                if cur_h > 30 and abs(cur_h - target_h) > 8:
                    scale = target_h / float(cur_h)
                    # Rescale subject tightly
                    sub_crop = img.crop((bbox[0], bbox[1], bbox[2], bbox[3]))
                    new_w = max(10, int(sub_crop.width * scale))
                    new_h = max(10, int(sub_crop.height * scale))
                    resized_sub = sub_crop.resize((new_w, new_h), Image.Resampling.LANCZOS)

                    # Re-paste onto empty canvas matching original tile dimensions, placed at bottom-center
                    canvas = Image.new("RGBA", img.size, (255, 255, 255, 0))
                    paste_x = (img.width - new_w) // 2
                    paste_y = bbox[3] - new_h  # Keep baseline aligned
                    if paste_y < 10:
                        paste_y = 10
                    canvas.paste(resized_sub, (paste_x, paste_y), resized_sub)
                    raw_cleaned_tiles[q_key] = (canvas, stats)

    # Save output tiles
    tiles_meta: dict[str, Any] = {}
    for q_key, (cleaned, stats) in raw_cleaned_tiles.items():
        tile_path = tiles_dir / f"{q_key}.png"
        cleaned.save(tile_path)
        tiles_meta[q_key] = {
            "path": str(tile_path),
            "expected_view": views[q_key],
            "crop_box": list(boxes[q_key]),
            "size": list(cleaned.size),
            **stats,
        }

    # Save step3_tiles.json to keep compatibility with the standard project format
    step3_payload = {
        "sheet_image_path": str(path),
        "sheet_size": [w, h],
        "trim_ratio": trim_ratio,
        "center_x_ratio": center_x_ratio,
        "center_y_ratio": center_y_ratio,
        "auto_normalized_heights": auto_normalize_heights,
        "tiles": tiles_meta,
    }
    with open(out_dir / "step3_tiles.json", "w", encoding="utf-8") as f:
        json.dump(step3_payload, f, indent=2)

    return step3_payload


def build_lite_3d_config(
    output_dir: Path | str,
    view_mapping: dict[str, str],
    octree_resolution: int = 320,
    num_inference_steps: int = 10,
    guidance_scale: float = 5.5,
    target_height_mm: float = 80.0,
    taubin_smooth_iterations: int = 2,
    character_name: str = "Lite 3D Asset",
) -> dict[str, Any]:
    """Create step4_3d_config.json directly without calling agy, binding user-confirmed view mappings."""
    out_dir = Path(output_dir).resolve()

    resolved_view_mapping: dict[str, str] = {}
    for view_key, tile_identifier in view_mapping.items():
        if not tile_identifier:
            continue
        # Identifier can be 'tile_tl', 'tile_tr', 'tile_bl', 'tile_br' or absolute path
        if "/" in tile_identifier or "\\" in tile_identifier:
            p = Path(tile_identifier)
        else:
            p = out_dir / "tiles" / f"{tile_identifier}.png"
        if p.is_file():
            resolved_view_mapping[view_key] = str(p)

    if "front" not in resolved_view_mapping and len(resolved_view_mapping) > 0:
        # Fallback: ensure at least front is defined
        first_key = next(iter(resolved_view_mapping))
        resolved_view_mapping["front"] = resolved_view_mapping[first_key]

    config_payload = {
        "view_mapping": resolved_view_mapping,
        "mesh_3d_prompt": f"Watertight 3D printable figurine: {character_name}",
        "octree_resolution": int(octree_resolution),
        "num_inference_steps": int(num_inference_steps),
        "guidance_scale": float(guidance_scale),
        "target_height_mm": float(target_height_mm),
        "taubin_smooth_iterations": int(taubin_smooth_iterations),
        "qa_notes": "Configured via Form 3D Lite mode with user-verified view mappings.",
    }

    with open(out_dir / "step4_3d_config.json", "w", encoding="utf-8") as f:
        json.dump(config_payload, f, indent=2)

    return config_payload
