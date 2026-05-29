"""
Image processing for Brand Templates.

Responsibilities:
  * Generate SigV4 presigned S3 PUT URLs for 1..5 browser uploads.
  * Download and copy objects between the uploads/ and skills/ prefixes.
  * Quantize dominant colors from N images and merge them into a single palette.
  * Classify colors into the schema's role buckets.
  * Render a palette swatch strip PNG for gallery previews.

The palette logic is ported from the old style-extraction code, adapted to
emit the new bucket names (primary, accent, background, surface, text,
border, states) and to operate over multiple images.
"""

from __future__ import annotations

import io
import os
import uuid
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import boto3
from botocore.config import Config
from PIL import Image, ImageDraw

Rgb = Tuple[int, int, int]
ColorPercent = Tuple[str, float]  # ("#rrggbb", percent)


ALLOWED_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
MAX_IMAGES = 5
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # enforced on presigned-URL content length

_PRESIGN_EXPIRY_SEC = 3600
_DEDUP_RGB_DISTANCE = 16  # treat two colors within this RGB distance as identical
_PREVIEW_W = 200
_PREVIEW_H = 40


def _validate_filename(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"Unsupported file extension: {ext}")
    return ext


class BrandTemplatesImageProcessor:
    def __init__(self, s3_client=None, bucket_name: str = "") -> None:
        if not bucket_name:
            raise ValueError("bucket_name is required")
        self._bucket = bucket_name
        if s3_client is None:
            # Force SigV4 so presigned URLs work with KMS-SSE buckets.
            #
            # Also force the regional endpoint (<bucket>.s3.<region>.amazonaws.com
            # rather than <bucket>.s3.amazonaws.com). The legacy global endpoint
            # returns 500 on OPTIONS preflight requests, which the browser then
            # reports as a CORS failure even though the bucket's CORS config is
            # correct. Pinning s3={"addressing_style": "virtual"} + explicit
            # region_name keeps the presigned hostname regional.
            region = (
                os.environ.get("AWS_REGION")
                or os.environ.get("AWS_DEFAULT_REGION")
                or "us-west-2"
            )
            self._s3 = boto3.client(
                "s3",
                region_name=region,
                config=Config(
                    signature_version="s3v4",
                    s3={"addressing_style": "virtual"},
                ),
            )
        else:
            self._s3 = s3_client

    # ---- S3 upload-URL generation --------------------------------------

    def create_upload_urls(
        self,
        *,
        user_id: str,
        filenames: Sequence[str],
        content_types: Sequence[str],
    ) -> Tuple[List[Dict[str, str]], str]:
        """
        Returns (uploads, job_id) where uploads is a list of
        {"url": <presigned>, "s3Key": <key>} in the same order as filenames.
        """
        if not 1 <= len(filenames) <= MAX_IMAGES:
            raise ValueError(f"Must supply 1..{MAX_IMAGES} filenames.")
        if len(filenames) != len(content_types):
            raise ValueError("filenames and content_types must be the same length.")

        job_id = str(uuid.uuid4())
        uploads: List[Dict[str, str]] = []
        for idx, (fname, ctype) in enumerate(zip(filenames, content_types)):
            ext = _validate_filename(fname)
            key = f"uploads/{user_id}/{job_id}/input-{idx}{ext}"
            url = self._s3.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": self._bucket,
                    "Key": key,
                    "ContentType": ctype,
                },
                ExpiresIn=_PRESIGN_EXPIRY_SEC,
            )
            uploads.append({"url": url, "s3Key": key})
        return uploads, job_id

    # ---- S3 I/O --------------------------------------------------------

    def head_object(self, *, s3_key: str) -> Dict[str, object]:
        """Raise if the object is missing, too large, or wrong content type."""
        resp = self._s3.head_object(Bucket=self._bucket, Key=s3_key)
        size = resp.get("ContentLength", 0)
        if size > MAX_UPLOAD_BYTES:
            raise ValueError(f"Object {s3_key} exceeds {MAX_UPLOAD_BYTES} bytes.")
        return resp

    def download_image(self, *, s3_key: str) -> bytes:
        resp = self._s3.get_object(Bucket=self._bucket, Key=s3_key)
        return resp["Body"].read()

    def put_object(self, *, s3_key: str, body: bytes, content_type: str) -> None:
        self._s3.put_object(
            Bucket=self._bucket,
            Key=s3_key,
            Body=body,
            ContentType=content_type,
        )

    def copy_uploads_to_skill(
        self,
        *,
        user_id: str,
        skill_id: str,
        source_keys: Sequence[str],
    ) -> List[str]:
        """Copy uploads/{user}/{job}/input-N.ext → skills/{user}/{skill}/input-N.ext."""
        new_keys: List[str] = []
        for idx, src_key in enumerate(source_keys):
            ext = Path(src_key).suffix.lower()
            if ext not in ALLOWED_EXTENSIONS:
                raise ValueError(f"Unsupported extension in source key: {src_key}")
            new_key = f"skills/{user_id}/{skill_id}/input-{idx}{ext}"
            self._s3.copy_object(
                Bucket=self._bucket,
                CopySource={"Bucket": self._bucket, "Key": src_key},
                Key=new_key,
            )
            new_keys.append(new_key)
        return new_keys

    def delete_skill_prefix(self, *, user_id: str, skill_id: str) -> None:
        prefix = f"skills/{user_id}/{skill_id}/"
        # list_objects_v2 returns at most 1000 keys per call. A skill prefix
        # is unlikely to exceed that under normal use, but we paginate so a
        # delete never silently leaves orphan objects (which would re-appear
        # if the skill id were ever reused).
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            contents = page.get("Contents") or []
            if not contents:
                continue
            self._s3.delete_objects(
                Bucket=self._bucket,
                Delete={"Objects": [{"Key": obj["Key"]} for obj in contents]},
            )

    # ---- palette extraction --------------------------------------------

    def merge_palettes(
        self,
        images_bytes: Iterable[bytes],
        *,
        n_colors_per_image: int = 10,
        max_output: int = 20,
    ) -> List[ColorPercent]:
        """
        Quantize each image independently, then merge the resulting palettes
        by de-duplicating colors within `_DEDUP_RGB_DISTANCE`.
        """
        merged: List[ColorPercent] = []
        for img_bytes in images_bytes:
            for hex_val, pct in self._quantize_image(img_bytes, n_colors_per_image):
                self._merge_into(merged, hex_val, pct)
        merged.sort(key=lambda x: x[1], reverse=True)
        return merged[:max_output]

    @staticmethod
    def _quantize_image(img_bytes: bytes, n_colors: int) -> List[ColorPercent]:
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        quantized = img.quantize(colors=n_colors, method=2)
        palette = quantized.getpalette() or []
        data = list(quantized.getdata())
        if not data:
            return []
        counts: Dict[int, int] = {}
        for pixel in data:
            counts[pixel] = counts.get(pixel, 0) + 1
        total = len(data)
        out: List[ColorPercent] = []
        for idx, count in counts.items():
            base = idx * 3
            if base + 2 >= len(palette):
                continue
            rgb = (palette[base], palette[base + 1], palette[base + 2])
            out.append((_rgb_to_hex(rgb), 100.0 * count / total))
        out.sort(key=lambda x: x[1], reverse=True)
        return out

    @staticmethod
    def _merge_into(
        merged: List[ColorPercent], hex_val: str, pct: float
    ) -> None:
        rgb = _hex_to_rgb(hex_val)
        for i, (existing_hex, existing_pct) in enumerate(merged):
            if _rgb_distance(_hex_to_rgb(existing_hex), rgb) <= _DEDUP_RGB_DISTANCE:
                merged[i] = (existing_hex, existing_pct + pct)
                return
        merged.append((hex_val, pct))

    def classify_colors(
        self, palette: Sequence[ColorPercent]
    ) -> Dict[str, List[Dict[str, str]]]:
        """
        Group quantized colors into the schema's role buckets.
        Deterministic and cheap — Bedrock gets to refine these later.
        """
        buckets: Dict[str, List[Dict[str, str]]] = {
            "primary": [],
            "accent": [],
            "background": [],
            "surface": [],
            "text": [],
            "border": [],
            "states": [],
        }
        if not palette:
            _ensure_nonempty(buckets, palette)
            return buckets

        primary_assigned = 0
        for idx, (hex_val, pct) in enumerate(palette):
            rgb = _hex_to_rgb(hex_val)
            lightness = _lightness(rgb)
            saturation = _saturation(rgb)
            token = {"hex": hex_val, "role": "", "usage": ""}

            # Very light OR very dark + high coverage → background/surface.
            if pct >= 5 and (lightness > 0.9 or lightness < 0.1):
                # First hit claims background; later ones become surface.
                if not buckets["background"]:
                    token["role"] = "background"
                    token["usage"] = "Page background"
                    buckets["background"].append(token)
                else:
                    token["role"] = "surface"
                    token["usage"] = "Card / elevated surface"
                    buckets["surface"].append(token)
                continue

            # Near-monochrome dark/light text colors.
            if saturation < 0.2 and (lightness < 0.25 or lightness > 0.75):
                token["role"] = "text"
                token["usage"] = "Body / headline text"
                buckets["text"].append(token)
                continue

            # High-saturation mid-lightness colors used as accents.
            if saturation >= 0.5 and 0.25 <= lightness <= 0.75:
                if primary_assigned < 2:
                    token["role"] = "primary"
                    token["usage"] = "Primary brand / CTA"
                    buckets["primary"].append(token)
                    primary_assigned += 1
                else:
                    token["role"] = "accent"
                    token["usage"] = "Accent / highlight"
                    buckets["accent"].append(token)
                continue

            # Low-saturation mids → borders/dividers.
            if saturation < 0.25 and 0.25 <= lightness <= 0.75:
                token["role"] = "border"
                token["usage"] = "Dividers / outlines"
                buckets["border"].append(token)
                continue

            # Everything else — assign as a hover state derivative.
            token["role"] = "state-hover" if idx % 2 == 0 else "state-active"
            token["usage"] = "Interactive state variation"
            buckets["states"].append(token)

        _ensure_nonempty(buckets, palette)
        return buckets

    # ---- preview render ------------------------------------------------

    def render_preview_swatch(self, top_colors: Sequence[str]) -> bytes:
        """
        Render a {width}x{height} PNG strip with up to 5 equal-width swatches.
        Returns PNG bytes.
        """
        swatches = list(top_colors[:5]) or ["#dddddd"]
        width = _PREVIEW_W
        height = _PREVIEW_H
        img = Image.new("RGB", (width, height), "#ffffff")
        draw = ImageDraw.Draw(img)
        col_w = width // len(swatches)
        for i, hex_val in enumerate(swatches):
            rgb = _hex_to_rgb(hex_val)
            x0 = i * col_w
            x1 = width if i == len(swatches) - 1 else x0 + col_w
            draw.rectangle([x0, 0, x1, height], fill=rgb)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


# ---- color math helpers ----------------------------------------------------


def _rgb_to_hex(rgb: Rgb) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def _hex_to_rgb(hex_val: str) -> Rgb:
    h = hex_val.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _rgb_distance(a: Rgb, b: Rgb) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def _lightness(rgb: Rgb) -> float:
    return sum(rgb) / (3 * 255)


def _saturation(rgb: Rgb) -> float:
    r, g, b = (c / 255 for c in rgb)
    max_c = max(r, g, b)
    min_c = min(r, g, b)
    return 0.0 if max_c == 0 else (max_c - min_c) / max_c


def _ensure_nonempty(
    buckets: Dict[str, List[Dict[str, str]]],
    palette: Sequence[ColorPercent],
) -> None:
    """
    Guarantee the primary/accent/background/surface/text/border/states buckets
    each have at least one color. The schema requires arrays (possibly empty)
    but the LLM layer works better with seed colors to refine.
    """
    defaults = {
        "primary": ("#5e6ad2", "Primary brand / CTA"),
        "accent": ("#f59e0b", "Accent / highlight"),
        "background": ("#ffffff", "Page background"),
        "surface": ("#f6f7f9", "Card / elevated surface"),
        "text": ("#111827", "Body / headline text"),
        "border": ("#e5e7eb", "Dividers / outlines"),
        "states": ("#3b82f6", "Interactive state variation"),
    }
    for bucket, (default_hex, usage) in defaults.items():
        if not buckets[bucket]:
            buckets[bucket].append(
                {"hex": default_hex, "role": bucket.rstrip("s"), "usage": usage}
            )
