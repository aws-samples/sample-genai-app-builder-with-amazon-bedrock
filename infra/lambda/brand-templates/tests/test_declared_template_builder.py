"""
Unit tests for declared_template_builder.build_declared_template.

Covers:
  - Output passes validate_brand_template() for a minimum palette-only input.
  - Output passes for a fully-populated tokens dict.
  - theme.mode is inferred from the first background hex.
  - spacing.scale keys and values derive from the supplied spacingBase.
  - copyVoice.adjectives is always within schema bounds (2..6) even when the
    caller supplies none.
  - styleDescriptor.label falls back to the skill name when descriptorLabel
    is absent, truncated to 40 chars.
  - Optional user-supplied tokens (families, radius, adjectives,
    descriptorLabel) override defaults and survive round-trip.

The builder is a PURE function — the caller supplies now_iso, the builder
never touches time or the environment.
"""

from __future__ import annotations

import pytest

from declared_template_builder import (  # type: ignore[import-not-found]
    build_declared_template,
)
from schema import validate_brand_template  # type: ignore[import-not-found]


USER_ID = "cognito-sub-abc"
SKILL_ID = "11111111-1111-4111-8111-111111111111"
JOB_ID = "22222222-2222-4222-8222-222222222222"
NOW_ISO = "2026-05-06T10:00:00+00:00"


def _minimum_palette() -> dict:
    """Seven required buckets, one #rrggbb each, a light background by default."""
    return {
        "primary":    [{"hex": "#00205b", "role": "primary"}],
        "accent":     [{"hex": "#ffa300", "role": "accent"}],
        "background": [{"hex": "#ffffff", "role": "background"}],
        "surface":    [{"hex": "#f5f7fa", "role": "surface"}],
        "text":       [{"hex": "#1a1a1a", "role": "text"}],
        "border":     [{"hex": "#d5d8dc", "role": "border"}],
        "states":     [{"hex": "#002b7a", "role": "state-hover"}],
    }


def _build(**tokens_overrides) -> dict:
    """Call the builder with a minimum-palette tokens dict plus optional overrides."""
    tokens = {"palette": _minimum_palette(), **tokens_overrides}
    return build_declared_template(
        user_id=USER_ID,
        skill_id=SKILL_ID,
        job_id=JOB_ID,
        name="Acme Corporate",
        description=None,
        tags=None,
        tokens=tokens,
        now_iso=NOW_ISO,
    )


# ---- happy paths ------------------------------------------------------------


def test_minimum_palette_builds_schema_valid_skill():
    skill = _build()
    validate_brand_template(skill)


def test_fully_populated_tokens_build_schema_valid_skill():
    skill = build_declared_template(
        user_id=USER_ID,
        skill_id=SKILL_ID,
        job_id=JOB_ID,
        name="OneAdvanced Corporate",
        description="Primary brand palette for internal tools.",
        tags=["corporate", "brand"],
        tokens={
            "palette": _minimum_palette(),
            "families": {"sans": "Source Sans Pro", "mono": "JetBrains Mono"},
            "spacingBase": "8px",
            "radius": {"md": "6px", "lg": "12px"},
            "adjectives": ["corporate", "trustworthy", "restrained"],
            "descriptorLabel": "OneAdvanced Corporate",
        },
        now_iso=NOW_ISO,
    )
    validate_brand_template(skill)
    assert skill["styleDescriptor"]["label"] == "OneAdvanced Corporate"
    assert skill["typography"]["families"]["sans"] == "Source Sans Pro"
    assert skill["typography"]["families"]["mono"] == "JetBrains Mono"
    assert skill["spacing"]["base"] == "8px"
    # User-supplied adjectives survive and drive copyVoice too.
    assert skill["styleDescriptor"]["adjectives"] == ["corporate", "trustworthy", "restrained"]


# ---- identity + provenance --------------------------------------------------


def test_identity_fields_are_passed_through():
    skill = _build()
    assert skill["userId"] == USER_ID
    assert skill["skillId"] == SKILL_ID
    assert skill["extractionJobId"] == JOB_ID
    assert skill["source"] == "declared"
    assert skill["status"] == "ready"
    assert skill["schemaVersion"] == 2
    assert skill["createdAt"] == NOW_ISO
    assert skill["updatedAt"] == NOW_ISO


def test_description_and_tags_are_passed_through():
    skill = build_declared_template(
        user_id=USER_ID,
        skill_id=SKILL_ID,
        job_id=JOB_ID,
        name="x",
        description="A description.",
        tags=["corporate", "brand"],
        tokens={"palette": _minimum_palette()},
        now_iso=NOW_ISO,
    )
    assert skill["description"] == "A description."
    assert skill["tags"] == ["corporate", "brand"]


def test_description_absent_not_emitted():
    # Schema allows omitting description; don't emit null.
    skill = _build()
    assert "description" not in skill or skill.get("description") is None


# ---- theme inference --------------------------------------------------------


def test_theme_mode_is_light_for_light_background():
    skill = _build()  # background is #ffffff by default
    assert skill["theme"]["mode"] == "light"


def test_theme_mode_is_dark_for_dark_background():
    palette = _minimum_palette()
    palette["background"][0]["hex"] = "#0b0e16"
    palette["text"][0]["hex"] = "#e6e8ec"  # keep text readable for human sanity
    skill = build_declared_template(
        user_id=USER_ID,
        skill_id=SKILL_ID,
        job_id=JOB_ID,
        name="Dark brand",
        description=None,
        tags=None,
        tokens={"palette": palette},
        now_iso=NOW_ISO,
    )
    assert skill["theme"]["mode"] == "dark"


@pytest.mark.parametrize(
    "hex_in,expected",
    [
        # Very light backgrounds resolve to light.
        ("#ffffff", "light"),
        ("#f5f7fa", "light"),
        # Mid-gray #808080 has WCAG luminance ~0.216 (sRGB gamma-corrected),
        # which is below the 0.5 threshold. 50% hex-gray ≠ 50% luminance.
        ("#808080", "dark"),
        # The 0.5-luminance boundary sits near #bcbcbc in sRGB.
        ("#bcbcbc", "light"),
        ("#0b0e16", "dark"),
        ("#000000", "dark"),
        ("#1a1a1a", "dark"),
    ],
)
def test_theme_mode_luminance_boundary(hex_in: str, expected: str):
    palette = _minimum_palette()
    palette["background"][0]["hex"] = hex_in
    skill = build_declared_template(
        user_id=USER_ID,
        skill_id=SKILL_ID,
        job_id=JOB_ID,
        name="x",
        description=None,
        tags=None,
        tokens={"palette": palette},
        now_iso=NOW_ISO,
    )
    assert skill["theme"]["mode"] == expected


# ---- spacing scale ---------------------------------------------------------


def test_spacing_scale_derives_from_base_4px():
    skill = _build(spacingBase="4px")
    assert skill["spacing"]["base"] == "4px"
    scale = skill["spacing"]["scale"]
    assert list(scale.keys()) == ["xs", "sm", "md", "lg", "xl", "2xl"]
    assert scale["xs"] == "4px"
    assert scale["sm"] == "8px"
    assert scale["md"] == "16px"
    assert scale["lg"] == "24px"
    assert scale["xl"] == "32px"
    assert scale["2xl"] == "48px"


def test_spacing_scale_derives_from_base_8px():
    skill = _build(spacingBase="8px")
    assert skill["spacing"]["base"] == "8px"
    scale = skill["spacing"]["scale"]
    assert scale["xs"] == "8px"
    assert scale["sm"] == "16px"
    assert scale["md"] == "32px"
    assert scale["lg"] == "48px"
    assert scale["xl"] == "64px"
    assert scale["2xl"] == "96px"


def test_spacing_scale_defaults_to_4px_when_missing():
    skill = _build()  # no spacingBase
    assert skill["spacing"]["base"] == "4px"


# ---- copyVoice adjectives bounds -------------------------------------------


def test_copy_voice_adjectives_when_none_supplied():
    skill = _build()
    adj = skill["copyVoice"]["adjectives"]
    assert 2 <= len(adj) <= 6
    for a in adj:
        assert isinstance(a, str) and a.strip()


def test_copy_voice_reuses_supplied_adjectives_capped_at_six():
    skill = _build(adjectives=["a", "b", "c", "d", "e", "f", "g", "h"])
    adj = skill["copyVoice"]["adjectives"]
    assert 2 <= len(adj) <= 6


def test_copy_voice_forbidden_always_includes_emdashes_and_ai_preamble():
    skill = _build()
    forbidden = skill["copyVoice"]["forbidden"]
    # Case-insensitive check so the exact phrasing in defaults can evolve.
    lowered = [f.lower() for f in forbidden]
    assert any("em-dash" in f for f in lowered)
    assert any("ai preamble" in f or "preamble" in f for f in lowered)


# ---- styleDescriptor.label fallback ---------------------------------------


def test_style_descriptor_label_uses_descriptor_label_when_supplied():
    skill = _build(descriptorLabel="Acme Bank 2026")
    assert skill["styleDescriptor"]["label"] == "Acme Bank 2026"


def test_style_descriptor_label_falls_back_to_name_truncated_at_40_chars():
    long_name = "This is a very long skill name that exceeds the descriptor length cap"
    skill = build_declared_template(
        user_id=USER_ID,
        skill_id=SKILL_ID,
        job_id=JOB_ID,
        name=long_name,
        description=None,
        tags=None,
        tokens={"palette": _minimum_palette()},
        now_iso=NOW_ISO,
    )
    assert len(skill["styleDescriptor"]["label"]) <= 40
    # First 40 chars of the name.
    assert skill["styleDescriptor"]["label"] == long_name[:40]


# ---- typography families ---------------------------------------------------


def test_typography_families_default_sans_to_system_ui():
    skill = _build()
    assert skill["typography"]["families"].get("sans") == "system-ui"


def test_typography_scale_uses_declared_sans_family_when_supplied():
    skill = _build(families={"sans": "Source Sans Pro"})
    family_names = {entry["fontFamily"] for entry in skill["typography"]["scale"]}
    assert "Source Sans Pro" in family_names


# ---- borders ---------------------------------------------------------------


def test_borders_radius_uses_supplied_values_when_provided():
    skill = _build(radius={"md": "6px"})
    assert skill["borders"]["radius"]["md"] == "6px"


def test_borders_radius_default_has_none_sm_md_lg_pill():
    skill = _build()
    radius = skill["borders"]["radius"]
    for key in ("none", "sm", "md", "lg", "pill"):
        assert key in radius


def test_borders_color_comes_from_palette_border():
    skill = _build()
    assert skill["borders"]["color"] == ["#d5d8dc"]


def test_borders_default_intents_for_enterprise_product():
    skill = _build()
    # Declared skills skew corporate/product, so sensible defaults keep
    # generated apps from drifting toward decorative shadows or expressive
    # borders unless the user explicitly opts in.
    assert skill["borders"]["intent"] == "hairline"
    assert skill["borders"]["radiusIntent"] == "subtle"


def test_shadows_default_intent_subtle():
    skill = _build()
    assert skill["shadows"]["intent"] == "subtle"


# ---- motion defaults -------------------------------------------------------


def test_motion_disallowed_patterns_include_bounce_and_elastic():
    skill = _build()
    disallowed = skill["motion"]["disallowedPatterns"]
    assert "bounce" in disallowed
    assert "elastic" in disallowed
    assert "layout-property-animation" in disallowed


# ---- purity ----------------------------------------------------------------


def test_builder_does_not_mutate_input_tokens():
    tokens = {"palette": _minimum_palette(), "families": {"sans": "Inter"}}
    original = {
        "palette": {k: [dict(v[0])] for k, v in tokens["palette"].items()},
        "families": dict(tokens["families"]),
    }

    build_declared_template(
        user_id=USER_ID,
        skill_id=SKILL_ID,
        job_id=JOB_ID,
        name="x",
        description=None,
        tags=None,
        tokens=tokens,
        now_iso=NOW_ISO,
    )

    assert tokens["palette"] == original["palette"]
    assert tokens["families"] == original["families"]
