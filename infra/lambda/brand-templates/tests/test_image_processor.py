"""
Unit tests for image_processor.py.

S3-touching tests use moto's mock_aws. Pure color-math tests construct
small in-memory PNGs with Pillow.
"""

from __future__ import annotations

import io
from typing import List

import boto3
import pytest
from moto import mock_aws
from PIL import Image

from image_processor import (  # type: ignore[import-not-found]
    BrandTemplatesImageProcessor,
    MAX_IMAGES,
)


BUCKET = "test-bucket"


@pytest.fixture(autouse=True)
def _aws_env(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


@pytest.fixture
def processor():
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-west-2")
        s3.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
        )
        yield BrandTemplatesImageProcessor(s3_client=s3, bucket_name=BUCKET)


def _solid_png(size_px: int, rgb: tuple, fmt: str = "PNG") -> bytes:
    img = Image.new("RGB", (size_px, size_px), rgb)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def _tri_color_png(size_px: int = 60) -> bytes:
    img = Image.new("RGB", (size_px, size_px), "#0b0e16")
    # Draw three colored bands.
    for y in range(0, size_px // 3):
        for x in range(size_px):
            img.putpixel((x, y), (94, 106, 210))  # primary-ish
    for y in range(size_px // 3, 2 * size_px // 3):
        for x in range(size_px):
            img.putpixel((x, y), (230, 232, 236))  # light text
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---- create_upload_urls ---------------------------------------------------


def test_create_upload_urls_returns_presigned_and_keys(processor):
    uploads, job_id = processor.create_upload_urls(
        user_id="u1",
        filenames=["a.png", "b.jpg"],
        content_types=["image/png", "image/jpeg"],
    )
    assert len(uploads) == 2
    assert all("s3Key" in u and "url" in u for u in uploads)
    assert uploads[0]["s3Key"] == f"uploads/u1/{job_id}/input-0.png"
    assert uploads[1]["s3Key"] == f"uploads/u1/{job_id}/input-1.jpg"
    for u in uploads:
        assert u["url"].startswith("https://")
        assert "X-Amz-Signature" in u["url"] or "Signature" in u["url"]


def test_create_upload_urls_rejects_unknown_extension(processor):
    with pytest.raises(ValueError):
        processor.create_upload_urls(
            user_id="u1",
            filenames=["evil.exe"],
            content_types=["application/octet-stream"],
        )


def test_create_upload_urls_rejects_zero_and_six(processor):
    with pytest.raises(ValueError):
        processor.create_upload_urls(user_id="u1", filenames=[], content_types=[])
    with pytest.raises(ValueError):
        processor.create_upload_urls(
            user_id="u1",
            filenames=[f"file-{i}.png" for i in range(MAX_IMAGES + 1)],
            content_types=["image/png"] * (MAX_IMAGES + 1),
        )


def test_create_upload_urls_rejects_mismatched_lists(processor):
    with pytest.raises(ValueError):
        processor.create_upload_urls(
            user_id="u1",
            filenames=["a.png"],
            content_types=["image/png", "image/jpeg"],
        )


# ---- palette merge + classify --------------------------------------------


def test_merge_palettes_deduplicates_near_colors(processor):
    imgs = [_solid_png(30, (94, 106, 210)), _solid_png(30, (96, 108, 212))]
    merged = processor.merge_palettes(imgs, n_colors_per_image=4)
    # The two near-identical colors should merge.
    assert any(h in ("#5e6ad2", "#606cd4") for h, _ in merged)
    # Merged percentage should roughly sum.
    top_hex, top_pct = merged[0]
    assert top_pct > 90


def test_merge_palettes_sorted_desc(processor):
    merged = processor.merge_palettes([_tri_color_png()], n_colors_per_image=6)
    pcts = [pct for _, pct in merged]
    assert pcts == sorted(pcts, reverse=True)


def test_classify_colors_seeds_empty_buckets(processor):
    buckets = processor.classify_colors([])
    assert set(buckets.keys()) == {
        "primary", "accent", "background", "surface", "text", "border", "states"
    }
    assert all(len(v) >= 1 for v in buckets.values())


def test_classify_colors_assigns_primary_for_saturated_mid_lightness(processor):
    palette = [("#5e6ad2", 40.0), ("#0b0e16", 30.0), ("#e6e8ec", 20.0)]
    buckets = processor.classify_colors(palette)
    primary_hexes = [t["hex"] for t in buckets["primary"]]
    assert "#5e6ad2" in primary_hexes


# ---- copy + preview -------------------------------------------------------


def test_copy_uploads_to_skill_rewrites_keys(processor):
    processor.put_object(
        s3_key="uploads/u1/job/input-0.png",
        body=_solid_png(4, (0, 0, 0)),
        content_type="image/png",
    )
    processor.put_object(
        s3_key="uploads/u1/job/input-1.jpg",
        body=_solid_png(4, (255, 255, 255), fmt="JPEG"),
        content_type="image/jpeg",
    )
    new_keys = processor.copy_uploads_to_skill(
        user_id="u1",
        skill_id="s1",
        source_keys=[
            "uploads/u1/job/input-0.png",
            "uploads/u1/job/input-1.jpg",
        ],
    )
    assert new_keys == [
        "skills/u1/s1/input-0.png",
        "skills/u1/s1/input-1.jpg",
    ]


def test_delete_skill_prefix_is_noop_when_empty(processor):
    processor.delete_skill_prefix(user_id="u1", skill_id="absent")


def test_render_preview_swatch_emits_png_bytes(processor):
    body = processor.render_preview_swatch(["#5e6ad2", "#f59e0b", "#0b0e16"])
    assert body[:8] == b"\x89PNG\r\n\x1a\n"


def test_render_preview_swatch_tolerates_empty_input(processor):
    body = processor.render_preview_swatch([])
    assert body[:8] == b"\x89PNG\r\n\x1a\n"
