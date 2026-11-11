"""Unit tests for Form 3D Lite helpers: CV analysis, slicing, and 3D configuration."""

from pathlib import Path
from PIL import Image, ImageDraw

from steps.lite_helpers import analyze_turnaround_sheet, build_lite_3d_config, slice_and_clean_lite


def _create_synthetic_sheet(path: Path, width: int = 400, height: int = 400) -> Path:
    """Create a synthetic 2x2 white background sheet with 4 distinct colored boxes."""
    img = Image.new("RGB", (width, height), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    # TL: Red box (Front)
    draw.rectangle([40, 40, 160, 160], fill=(200, 50, 50))
    # TR: Green box (Right)
    draw.rectangle([240, 40, 360, 160], fill=(50, 200, 50))
    # BL: Blue box (Back)
    draw.rectangle([40, 240, 160, 360], fill=(50, 50, 200))
    # BR: Yellow box (Left)
    draw.rectangle([240, 240, 360, 360], fill=(200, 200, 50))

    img.save(path)
    return path


def test_analyze_turnaround_sheet(tmp_path: Path):
    sheet_path = _create_synthetic_sheet(tmp_path / "sheet.png")

    result = analyze_turnaround_sheet(sheet_path)

    assert result["width"] == 400
    assert result["height"] == 400
    assert result["is_square"] is True
    assert result["is_white_bg"] is True

    # Check detected center
    assert 0.45 <= result["suggested_center_x"] <= 0.55
    assert 0.45 <= result["suggested_center_y"] <= 0.55

    # Check 4 quadrants info
    assert "quadrants" in result
    for q in ["tile_tl", "tile_tr", "tile_bl", "tile_br"]:
        assert q in result["quadrants"]
        assert result["quadrants"][q]["has_subject"] is True
        assert result["quadrants"][q]["subject_height"] > 0


def test_slice_and_clean_lite(tmp_path: Path):
    sheet_path = _create_synthetic_sheet(tmp_path / "sheet.png")
    out_dir = tmp_path / "output_tiles"

    result = slice_and_clean_lite(
        sheet_path=sheet_path,
        output_dir=out_dir,
        center_x_ratio=0.5,
        center_y_ratio=0.5,
        auto_normalize_heights=True,
    )

    assert "tiles" in result
    assert len(result["tiles"]) == 4
    for tile_key in ["tile_tl", "tile_tr", "tile_bl", "tile_br"]:
        assert tile_key in result["tiles"]
        tile_path = Path(result["tiles"][tile_key]["path"])
        assert tile_path.is_file()
        with Image.open(tile_path) as im:
            assert im.mode == "RGBA"


def test_build_lite_3d_config(tmp_path: Path):
    tiles_dir = tmp_path / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)
    for name in ["tile_tl", "tile_tr", "tile_bl", "tile_br"]:
        (tiles_dir / f"{name}.png").write_bytes(b"dummy png bytes")

    view_mapping = {
        "front": "tile_tl",
        "left": "tile_br",
        "back": "tile_bl",
        "right": "tile_tr",
    }

    cfg = build_lite_3d_config(
        output_dir=tmp_path,
        view_mapping=view_mapping,
        octree_resolution=384,
        num_inference_steps=12,
        guidance_scale=6.0,
        target_height_mm=85.0,
        taubin_smooth_iterations=3,
        character_name="Test Figurine",
    )

    assert cfg["octree_resolution"] == 384
    assert cfg["num_inference_steps"] == 12
    assert cfg["guidance_scale"] == 6.0
    assert cfg["target_height_mm"] == 85.0
    assert cfg["taubin_smooth_iterations"] == 3
    assert "Test Figurine" in cfg["mesh_3d_prompt"]
    assert (tmp_path / "step4_3d_config.json").is_file()
