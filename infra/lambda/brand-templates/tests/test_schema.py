"""
Unit tests for schema.py — BrandTemplate JSON Schema validation.

These tests are intended to run inside the `infra/lambda/brand-templates/` directory
with that directory on sys.path (matching the Lambda runtime import layout).
A conftest.py in this tests/ folder adds the parent directory to sys.path.
"""

import json
import re
from copy import deepcopy
from pathlib import Path

import pytest

from schema import (  # type: ignore[import-not-found]
    SchemaValidationError,
    validate_create_request,
    validate_brand_template,
    validate_patch_request,
)


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "minimal_template.json"


def _load_minimal_template() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


# ---- full skill validation --------------------------------------------------


def test_minimal_valid_skill_passes():
    validate_brand_template(_load_minimal_template())


def test_missing_style_descriptor_fails():
    skill = _load_minimal_template()
    del skill["styleDescriptor"]
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_non_hex_color_fails():
    skill = _load_minimal_template()
    skill["palette"]["primary"][0]["hex"] = "blue"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_wrong_schema_version_fails():
    skill = _load_minimal_template()
    skill["schemaVersion"] = 3
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_extra_top_level_field_rejected():
    skill = _load_minimal_template()
    skill["extraField"] = "not allowed"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_unknown_status_fails():
    skill = _load_minimal_template()
    skill["status"] = "cooking"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_tag_format_enforced_on_full_skill():
    skill = _load_minimal_template()
    skill["tags"] = ["UPPERCASE"]
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


# ---- enriched model (v2) fields ----


def test_missing_register_fails():
    skill = _load_minimal_template()
    del skill["register"]
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_register_kind_constrained_to_brand_or_product():
    skill = _load_minimal_template()
    skill["register"]["kind"] = "marketing"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_missing_color_strategy_fails():
    skill = _load_minimal_template()
    del skill["colorStrategy"]
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_color_strategy_tier_must_be_known():
    skill = _load_minimal_template()
    skill["colorStrategy"]["tier"] = "intense"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_theme_requires_scene_sentence():
    skill = _load_minimal_template()
    skill["theme"]["sceneSentence"] = "too short"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_information_hierarchy_requires_focal_order():
    skill = _load_minimal_template()
    skill["informationHierarchy"]["focalOrder"] = []
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_typography_principles_enforces_body_line_length_range():
    skill = _load_minimal_template()
    skill["typography"]["principles"]["bodyLineLengthCh"] = 200  # out of range
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_typography_principles_enforces_min_scale_ratio():
    skill = _load_minimal_template()
    skill["typography"]["principles"]["scaleRatio"] = 0.9
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_spacing_requires_rhythm_rules():
    skill = _load_minimal_template()
    skill["spacing"]["rhythmRules"] = []
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_motion_disallowed_pattern_must_be_known_enum():
    skill = _load_minimal_template()
    skill["motion"]["disallowedPatterns"] = ["made-up-pattern"]
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_anti_references_bans_observed_restricted_to_enum():
    skill = _load_minimal_template()
    skill["antiReferences"]["bansObserved"] = ["some-random-string"]
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_copy_voice_case_constrained():
    skill = _load_minimal_template()
    skill["copyVoice"]["case"] = "camelCase"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


# ---- UI-system intent fields (optional, v3 additions) ----------------------


@pytest.mark.parametrize(
    "intent",
    ["none", "subtle", "elevation-only", "distinctive"],
)
def test_shadows_intent_accepts_known_enum(intent: str):
    skill = _load_minimal_template()
    skill["shadows"]["intent"] = intent
    validate_brand_template(skill)


def test_shadows_intent_rejects_unknown():
    skill = _load_minimal_template()
    skill["shadows"]["intent"] = "shadow-drama"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


@pytest.mark.parametrize(
    "intent",
    ["none", "hairline", "filled", "expressive"],
)
def test_borders_intent_accepts_known_enum(intent: str):
    skill = _load_minimal_template()
    skill["borders"]["intent"] = intent
    validate_brand_template(skill)


def test_borders_intent_rejects_unknown():
    skill = _load_minimal_template()
    skill["borders"]["intent"] = "chunky"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


@pytest.mark.parametrize(
    "intent",
    ["sharp", "subtle", "pronounced", "pill-first"],
)
def test_borders_radius_intent_accepts_known_enum(intent: str):
    skill = _load_minimal_template()
    skill["borders"]["radiusIntent"] = intent
    validate_brand_template(skill)


def test_borders_radius_intent_rejects_unknown():
    skill = _load_minimal_template()
    skill["borders"]["radiusIntent"] = "roundy"
    with pytest.raises(SchemaValidationError):
        validate_brand_template(skill)


def test_skill_valid_without_any_intents():
    """Intents are optional — skills written before v3 continue to validate."""
    skill = _load_minimal_template()
    skill["borders"].pop("intent", None)
    skill["borders"].pop("radiusIntent", None)
    skill["shadows"].pop("intent", None)
    validate_brand_template(skill)


# ---- create request validation ---------------------------------------------


def test_create_request_images_variant():
    req = {
        "name": "My skill",
        "source": "images",
        "jobId": "11111111-1111-4111-8111-111111111111",
        "s3Keys": ["uploads/u/11111111-1111-4111-8111-111111111111/input-0.png"],
    }
    validate_create_request(req)


def test_create_request_url_variant():
    validate_create_request({"name": "My skill", "source": "url", "url": "https://example.com"})


def test_create_request_rejects_http():
    with pytest.raises(SchemaValidationError):
        validate_create_request({"name": "My skill", "source": "url", "url": "http://example.com"})


def test_create_request_rejects_missing_name():
    with pytest.raises(SchemaValidationError):
        validate_create_request({"source": "url", "url": "https://example.com"})


def test_create_request_rejects_bad_source():
    with pytest.raises(SchemaValidationError):
        validate_create_request({"name": "x", "source": "whatever"})


def test_create_request_rejects_empty_s3_keys():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "images",
                "jobId": "11111111-1111-4111-8111-111111111111",
                "s3Keys": [],
            }
        )


def test_create_request_rejects_too_many_s3_keys():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "images",
                "jobId": "11111111-1111-4111-8111-111111111111",
                "s3Keys": [f"uploads/u/job/input-{i}.png" for i in range(6)],
            }
        )


def test_create_request_rejects_non_upload_key():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "images",
                "jobId": "11111111-1111-4111-8111-111111111111",
                "s3Keys": ["evil/elsewhere/file.png"],
            }
        )


def test_create_request_rejects_bad_tags():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {"name": "x", "source": "url", "url": "https://e.com", "tags": ["Bad Tag"]}
        )


# ---- declared-variant create requests --------------------------------------


def _valid_declared_palette() -> dict:
    """Minimum palette that satisfies the declared-variant validator."""
    return {
        "primary":    [{"hex": "#00205b", "role": "primary"}],
        "accent":     [{"hex": "#ffa300", "role": "accent"}],
        "background": [{"hex": "#ffffff", "role": "background"}],
        "surface":    [{"hex": "#f5f7fa", "role": "surface"}],
        "text":       [{"hex": "#1a1a1a", "role": "text"}],
        "border":     [{"hex": "#d5d8dc", "role": "border"}],
        "states":     [{"hex": "#002b7a", "role": "state-hover"}],
    }


def test_declared_variant_minimal_palette_passes():
    validate_create_request(
        {
            "name": "OneAdvanced Corporate",
            "source": "declared",
            "tokens": {"palette": _valid_declared_palette()},
        }
    )


def test_declared_variant_full_optional_fields_pass():
    validate_create_request(
        {
            "name": "OneAdvanced Corporate",
            "description": "Brand tokens for internal tools",
            "tags": ["corporate", "brand"],
            "source": "declared",
            "tokens": {
                "palette": _valid_declared_palette(),
                "families": {
                    "sans": "Source Sans Pro",
                    "mono": "JetBrains Mono",
                },
                "spacingBase": "4px",
                "radius": {"md": "6px", "lg": "12px"},
                "adjectives": ["corporate", "trustworthy", "restrained"],
                "descriptorLabel": "OneAdvanced Corporate",
            },
        }
    )


def test_declared_variant_rejects_missing_tokens_object():
    with pytest.raises(SchemaValidationError):
        validate_create_request({"name": "x", "source": "declared"})


def test_declared_variant_rejects_non_object_tokens():
    with pytest.raises(SchemaValidationError):
        validate_create_request({"name": "x", "source": "declared", "tokens": "nope"})


def test_declared_variant_rejects_missing_palette():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {"name": "x", "source": "declared", "tokens": {"families": {"sans": "Inter"}}}
        )


@pytest.mark.parametrize(
    "missing",
    ["primary", "accent", "background", "surface", "text", "border", "states"],
)
def test_declared_variant_rejects_missing_palette_bucket(missing: str):
    palette = _valid_declared_palette()
    del palette[missing]
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {"name": "x", "source": "declared", "tokens": {"palette": palette}}
        )


def test_declared_variant_rejects_empty_palette_bucket():
    palette = _valid_declared_palette()
    palette["accent"] = []
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {"name": "x", "source": "declared", "tokens": {"palette": palette}}
        )


def test_declared_variant_rejects_bad_hex():
    palette = _valid_declared_palette()
    palette["primary"][0]["hex"] = "blue"
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {"name": "x", "source": "declared", "tokens": {"palette": palette}}
        )


def test_declared_variant_rejects_missing_hex():
    palette = _valid_declared_palette()
    del palette["primary"][0]["hex"]
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {"name": "x", "source": "declared", "tokens": {"palette": palette}}
        )


def test_declared_variant_rejects_missing_role():
    palette = _valid_declared_palette()
    del palette["primary"][0]["role"]
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {"name": "x", "source": "declared", "tokens": {"palette": palette}}
        )


def test_declared_variant_rejects_non_dict_entry():
    palette = _valid_declared_palette()
    palette["primary"][0] = "not-a-dict"
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {"name": "x", "source": "declared", "tokens": {"palette": palette}}
        )


def test_declared_variant_spacing_base_accepts_4px_and_8px():
    for base in ("4px", "8px"):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {"palette": _valid_declared_palette(), "spacingBase": base},
            }
        )


def test_declared_variant_rejects_bad_spacing_base():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {"palette": _valid_declared_palette(), "spacingBase": "12px"},
            }
        )


def test_declared_variant_rejects_non_object_families():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {"palette": _valid_declared_palette(), "families": "Inter"},
            }
        )


def test_declared_variant_rejects_non_string_family_value():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {
                    "palette": _valid_declared_palette(),
                    "families": {"sans": 123},
                },
            }
        )


def test_declared_variant_rejects_non_object_radius():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {
                    "palette": _valid_declared_palette(),
                    "radius": ["6px"],
                },
            }
        )


def test_declared_variant_rejects_too_few_adjectives():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {
                    "palette": _valid_declared_palette(),
                    "adjectives": ["only-one", "only-two"],  # minItems is 3
                },
            }
        )


def test_declared_variant_rejects_too_many_adjectives():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {
                    "palette": _valid_declared_palette(),
                    "adjectives": ["a"] * 9,
                },
            }
        )


def test_declared_variant_rejects_empty_adjective_entry():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {
                    "palette": _valid_declared_palette(),
                    "adjectives": ["ok", "  ", "also-ok"],
                },
            }
        )


def test_declared_variant_rejects_oversize_descriptor_label():
    with pytest.raises(SchemaValidationError):
        validate_create_request(
            {
                "name": "x",
                "source": "declared",
                "tokens": {
                    "palette": _valid_declared_palette(),
                    "descriptorLabel": "x" * 100,
                },
            }
        )


# ---- patch request validation ----------------------------------------------


def test_patch_request_allows_only_metadata():
    validate_patch_request({"name": "Renamed"})
    validate_patch_request({"tags": ["brand", "editorial"]})
    validate_patch_request({"description": "Updated."})
    validate_patch_request({"name": "A", "description": "B", "tags": ["c"]})


def test_patch_request_rejects_token_field():
    with pytest.raises(SchemaValidationError):
        validate_patch_request({"palette": {"primary": []}})


def test_patch_request_rejects_empty():
    with pytest.raises(SchemaValidationError):
        validate_patch_request({})


def test_patch_request_rejects_non_object():
    with pytest.raises(SchemaValidationError):
        validate_patch_request(["not", "an", "object"])


def test_patch_request_rejects_oversize_name():
    with pytest.raises(SchemaValidationError):
        validate_patch_request({"name": "x" * 200})
