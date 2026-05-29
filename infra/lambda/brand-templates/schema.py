"""
JSON Schema validators for the Brand Templates Lambda.

Three entrypoints:
    validate_brand_template(obj)    — full BrandTemplate record shape.
    validate_create_request(obj)  — POST /v1/brand-templates body (images or url variant).
    validate_patch_request(obj)   — PATCH /v1/brand-templates/{skillId} body (metadata only).

All validators raise SchemaValidationError with a sanitized, user-safe message on
failure. The raw jsonschema path/message is kept on the exception for logging
but never exposed in HTTP responses by the Lambda handler.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List

from jsonschema import Draft202012Validator


_SCHEMA_PATH = Path(__file__).parent / "brand_template.schema.json"

with _SCHEMA_PATH.open("r", encoding="utf-8") as _fh:
    _DESIGN_SKILL_SCHEMA: Dict[str, Any] = json.load(_fh)

_DESIGN_SKILL_VALIDATOR = Draft202012Validator(_DESIGN_SKILL_SCHEMA)


_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_TAG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_HTTPS_URL_PATTERN = re.compile(r"^https://[^\s]+$")

_MAX_NAME_LEN = 80
_MAX_DESCRIPTION_LEN = 500
_MAX_TAGS = 10
_MAX_IMAGES = 5
_MIN_IMAGES = 1
_ALLOWED_SOURCES = {"images", "url", "declared"}

# Declared-variant constraints — kept local to schema.py because they're
# part of the request contract, not user-facing skill fields.
_HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
_REQUIRED_PALETTE_BUCKETS: tuple[str, ...] = (
    "primary",
    "accent",
    "background",
    "surface",
    "text",
    "border",
    "states",
)
_MIN_DECLARED_ADJECTIVES = 3
_MAX_DECLARED_ADJECTIVES = 8
_MAX_DECLARED_DESCRIPTOR_LEN = 40
_ALLOWED_DECLARED_SPACING_BASES = {"4px", "8px"}
_ALLOWED_DECLARED_FAMILY_KEYS = {"sans", "serif", "mono", "display"}


# Allowed metadata fields on PATCH. Any other field is rejected with 400 so that
# the HTTP surface area never becomes a backdoor for mutating extracted tokens.
_PATCH_ALLOWED_FIELDS = frozenset({"name", "description", "tags"})


class SchemaValidationError(ValueError):
    """
    Raised when a payload fails validation. The `message` is safe to surface to
    the HTTP client; `detail` carries the jsonschema error path for logging only.
    """

    def __init__(self, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail

    def __str__(self) -> str:  # pragma: no cover - trivial
        if self.detail:
            return f"{self.message} ({self.detail})"
        return self.message


def validate_brand_template(obj: Any) -> None:
    """Validate a full BrandTemplate record against the JSON schema."""
    errors = sorted(_DESIGN_SKILL_VALIDATOR.iter_errors(obj), key=lambda e: e.path)
    if errors:
        first = errors[0]
        path = ".".join(str(p) for p in first.absolute_path) or "<root>"
        raise SchemaValidationError(
            "Brand template failed schema validation.",
            detail=f"{path}: {first.message}",
        )


def validate_create_request(body: Any) -> None:
    """
    Validate POST /v1/brand-templates body. Three variants:

    images:
        { name, description?, tags?, source: "images",
          jobId, s3Keys: [1..5 strings] }

    url:
        { name, description?, tags?, source: "url", url: "https://..." }

    declared:
        { name, description?, tags?, source: "declared",
          tokens: { palette: {7 required buckets}, families?, spacingBase?,
                    radius?, adjectives?, descriptorLabel? } }
    """
    _require_object(body, "body")
    _validate_metadata(body)

    source = body.get("source")
    if source not in _ALLOWED_SOURCES:
        raise SchemaValidationError(
            "Field 'source' must be 'images', 'url', or 'declared'.",
        )

    if source == "images":
        _validate_images_variant(body)
    elif source == "url":
        _validate_url_variant(body)
    else:
        _validate_declared_variant(body)


def validate_patch_request(body: Any) -> None:
    """
    Validate PATCH /v1/brand-templates/{skillId} body. Allows only metadata fields.
    """
    _require_object(body, "body")

    unknown = set(body.keys()) - _PATCH_ALLOWED_FIELDS
    if unknown:
        raise SchemaValidationError(
            "Only name, description, and tags may be edited.",
            detail=f"unexpected fields: {sorted(unknown)}",
        )

    if not body:
        raise SchemaValidationError("Patch body must include at least one field.")

    _validate_metadata(body, require_name=False)


def _validate_metadata(body: Dict[str, Any], *, require_name: bool = True) -> None:
    if require_name:
        name = body.get("name")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= _MAX_NAME_LEN:
            raise SchemaValidationError(
                f"Field 'name' is required and must be 1..{_MAX_NAME_LEN} characters.",
            )
    elif "name" in body:
        name = body["name"]
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= _MAX_NAME_LEN:
            raise SchemaValidationError(
                f"Field 'name' must be 1..{_MAX_NAME_LEN} characters.",
            )

    if "description" in body:
        desc = body["description"]
        if not isinstance(desc, str) or len(desc) > _MAX_DESCRIPTION_LEN:
            raise SchemaValidationError(
                f"Field 'description' must be a string up to {_MAX_DESCRIPTION_LEN} characters.",
            )

    if "tags" in body:
        tags = body["tags"]
        if not isinstance(tags, list) or len(tags) > _MAX_TAGS:
            raise SchemaValidationError(
                f"Field 'tags' must be an array of up to {_MAX_TAGS} entries.",
            )
        for tag in tags:
            if not isinstance(tag, str) or not _TAG_PATTERN.match(tag):
                raise SchemaValidationError(
                    "Tags must be lowercase a-z, 0-9, or '-', 1..32 characters, "
                    "starting with a letter or digit.",
                )


def _validate_images_variant(body: Dict[str, Any]) -> None:
    job_id = body.get("jobId")
    if not isinstance(job_id, str) or not _UUID_PATTERN.match(job_id):
        raise SchemaValidationError("Field 'jobId' must be a UUID.")

    s3_keys = body.get("s3Keys")
    if not isinstance(s3_keys, list) or not _MIN_IMAGES <= len(s3_keys) <= _MAX_IMAGES:
        raise SchemaValidationError(
            f"Field 's3Keys' must be a list of {_MIN_IMAGES}..{_MAX_IMAGES} items.",
        )
    for key in s3_keys:
        if not isinstance(key, str) or not key.startswith("uploads/"):
            raise SchemaValidationError(
                "Every entry in 's3Keys' must be an uploads/* key string.",
            )


def _validate_url_variant(body: Dict[str, Any]) -> None:
    url = body.get("url")
    if not isinstance(url, str) or not _HTTPS_URL_PATTERN.match(url):
        raise SchemaValidationError("Field 'url' must be an https:// URL.")
    if len(url) > 2048:
        raise SchemaValidationError("Field 'url' must be at most 2048 characters.")


def _validate_declared_variant(body: Dict[str, Any]) -> None:
    """
    Validate the `declared` source variant's `tokens` block.

    Required: tokens.palette with every bucket in _REQUIRED_PALETTE_BUCKETS,
    each non-empty, each entry holding a valid 6-digit hex + non-blank role.

    Optional blocks (families, spacingBase, radius, adjectives,
    descriptorLabel) are type-checked here. Semantic defaults for anything
    not supplied are applied downstream by declared_template_builder; this
    validator never papers over a missing palette bucket because palette
    is the whole point of the declared path.
    """
    tokens = body.get("tokens")
    if not isinstance(tokens, dict):
        raise SchemaValidationError("Field 'tokens' must be an object.")

    palette = tokens.get("palette")
    if not isinstance(palette, dict):
        raise SchemaValidationError("Field 'tokens.palette' must be an object.")

    for bucket in _REQUIRED_PALETTE_BUCKETS:
        entries = palette.get(bucket)
        if not isinstance(entries, list) or not entries:
            raise SchemaValidationError(
                f"Field 'tokens.palette.{bucket}' must be a non-empty array.",
            )
        for i, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise SchemaValidationError(
                    f"'tokens.palette.{bucket}[{i}]' must be an object.",
                )
            hex_val = entry.get("hex")
            role = entry.get("role")
            if not isinstance(hex_val, str) or not _HEX_PATTERN.match(hex_val):
                raise SchemaValidationError(
                    f"'tokens.palette.{bucket}[{i}].hex' must be #rrggbb.",
                )
            if not isinstance(role, str) or not role.strip():
                raise SchemaValidationError(
                    f"'tokens.palette.{bucket}[{i}].role' is required.",
                )

    families = tokens.get("families")
    if families is not None:
        if not isinstance(families, dict):
            raise SchemaValidationError("'tokens.families' must be an object.")
        unknown = set(families.keys()) - _ALLOWED_DECLARED_FAMILY_KEYS
        if unknown:
            raise SchemaValidationError(
                "'tokens.families' only accepts sans/serif/mono/display.",
                detail=f"unexpected keys: {sorted(unknown)}",
            )
        for key, value in families.items():
            if not isinstance(value, str) or not value.strip():
                raise SchemaValidationError(
                    f"'tokens.families.{key}' must be a non-empty string.",
                )

    spacing_base = tokens.get("spacingBase")
    if spacing_base is not None and (
        not isinstance(spacing_base, str)
        or spacing_base not in _ALLOWED_DECLARED_SPACING_BASES
    ):
        raise SchemaValidationError("'tokens.spacingBase' must be '4px' or '8px'.")

    radius = tokens.get("radius")
    if radius is not None and not isinstance(radius, dict):
        raise SchemaValidationError(
            "'tokens.radius' must be an object of name→CSS value.",
        )

    adjectives = tokens.get("adjectives")
    if adjectives is not None:
        if not isinstance(adjectives, list):
            raise SchemaValidationError("'tokens.adjectives' must be an array.")
        if not _MIN_DECLARED_ADJECTIVES <= len(adjectives) <= _MAX_DECLARED_ADJECTIVES:
            raise SchemaValidationError(
                f"'tokens.adjectives' must have "
                f"{_MIN_DECLARED_ADJECTIVES}..{_MAX_DECLARED_ADJECTIVES} entries.",
            )
        for adj in adjectives:
            if not isinstance(adj, str) or not adj.strip():
                raise SchemaValidationError(
                    "Each entry in 'tokens.adjectives' must be a non-empty string.",
                )

    descriptor = tokens.get("descriptorLabel")
    if descriptor is not None:
        if (
            not isinstance(descriptor, str)
            or not 1 <= len(descriptor) <= _MAX_DECLARED_DESCRIPTOR_LEN
        ):
            raise SchemaValidationError(
                f"'tokens.descriptorLabel' must be 1..{_MAX_DECLARED_DESCRIPTOR_LEN} characters.",
            )


def _require_object(obj: Any, label: str) -> None:
    if not isinstance(obj, dict):
        raise SchemaValidationError(f"{label} must be a JSON object.")
