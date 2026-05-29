"""Tests for the BrandTemplateExtractor — mocks Bedrock, real image processor for palette."""

from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest

from brand_template_extractor import (  # type: ignore[import-not-found]
    BrandTemplateExtractor,
    ExtractionError,
)


SKILL_ID = "11111111-1111-4111-8111-111111111111"
JOB_ID = "22222222-2222-4222-8222-222222222222"
USER_ID = "cognito-sub-abc"


def _valid_tokens() -> Dict[str, Any]:
    return {
        "register": {
            "kind": "brand",
            "rationale": "Design IS the product — this is an editorial long-form reading surface.",
        },
        "styleDescriptor": {
            "label": "editorial",
            "rationale": "High-contrast type, generous whitespace, restrained color.",
            "adjectives": ["editorial", "minimal", "confident"],
        },
        "colorStrategy": {
            "tier": "restrained",
            "accentCoveragePct": 6,
            "rationale": "Tinted neutrals carry the surface; accent appears only on the CTA.",
        },
        "theme": {
            "mode": "dark",
            "sceneSentence": "Designer reading long-form essays on a 14-inch laptop in a dim studio after dusk.",
            "rationale": "The dim-studio scene forces a dark page.",
        },
        "informationHierarchy": {
            "focalOrder": [
                {"rank": 1, "element": "Display headline", "role": "Anchors the viewer."}
            ],
            "principles": ["Scale contrast over color contrast"],
        },
        "antiReferences": {
            "firstOrderReflexes": ["AI tool → SaaS-cream + purple gradient"],
            "secondOrderReflexes": ["Editorial-typographic beige-and-serif"],
            "bansObserved": ["gradient-text"],
        },
        "copyVoice": {
            "adjectives": ["confident", "editorial"],
            "case": "sentence",
            "density": "sparse",
            "forbidden": ["em-dashes", "AI preamble phrases"],
            "examples": [{"kind": "headline", "text": "A quieter way to read."}],
        },
        "palette": {
            "primary":    [{"hex": "#5e6ad2", "role": "primary", "usage": "CTA"}],
            "accent":     [{"hex": "#f59e0b", "role": "accent", "usage": "Highlights"}],
            "background": [{"hex": "#0b0e16", "role": "background", "usage": "Page bg"}],
            "surface":    [{"hex": "#1f2633", "role": "surface", "usage": "Cards"}],
            "text":       [{"hex": "#e6e8ec", "role": "text", "usage": "Body"}],
            "border":     [{"hex": "#262b36", "role": "border", "usage": "Dividers"}],
            "states":     [{"hex": "#3b82f6", "role": "state-hover", "usage": "Hover"}],
        },
        "typography": {
            "families": {"sans": "Inter", "mono": "JetBrains Mono"},
            "scale": [
                {"name": "body", "fontFamily": "Inter", "fontSize": "16px",
                 "fontWeight": 400, "lineHeight": "1.5"},
            ],
            "principles": {
                "bodyLineLengthCh": 72,
                "scaleRatio": 1.333,
                "hierarchyStrategy": "Weight + scale contrast carry the hierarchy.",
            },
        },
        "borders": {
            "radius": {"sm": "4px", "md": "6px", "lg": "12px"},
            "width":  {"thin": "1px", "normal": "2px"},
            "color":  ["#262b36"],
        },
        "shadows": {
            "elevation": [
                {"name": "sm", "value": "0 1px 2px rgba(0,0,0,0.3)", "description": "Base"}
            ],
        },
        "spacing": {
            "base": "4px",
            "scale": {"xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px"},
            "rhythmNotes": "Generous padding on cards.",
            "rhythmRules": [
                "Cards use 24px padding; list rows use 8px",
                "Section gap is 80px on hero, 40px elsewhere",
            ],
        },
        "motion": {
            "tokens": [
                {"name": "default", "duration": "180ms", "easing": "cubic-bezier(0.4,0,0.2,1)"}
            ],
            "habits": ["Fades over translations"],
            "disallowedPatterns": ["bounce", "elastic", "layout-property-animation"],
        },
        "exemplars": [
            {"kind": "do", "summary": "Use generous line-height", "rationale": "Editorial feel."}
        ],
    }


class _FakeBedrock:
    def __init__(self, responses: List[str]):
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def converse(self, **kwargs) -> str:
        self.calls.append(kwargs)
        return self._responses.pop(0)


class _FakeImageProcessor:
    def __init__(self, palette=None):
        self._palette = palette or [("#5e6ad2", 40.0), ("#0b0e16", 30.0)]

    def merge_palettes(self, images, **_):
        return list(self._palette)


@pytest.fixture
def img_bytes():
    return b"\x89PNG\r\n\x1a\n" + b"x" * 32


# ---- happy path ---------------------------------------------------------


def test_extracts_schema_valid_skill_on_first_try(img_bytes):
    bedrock = _FakeBedrock([json.dumps(_valid_tokens())])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    skill = extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="images", name="Editorial mono",
        source_images_s3_keys=["skills/u/s/input-0.png"],
    )
    assert skill["schemaVersion"] == 2
    assert skill["source"] == "images"
    assert skill["styleDescriptor"]["label"] == "editorial"
    assert skill["register"]["kind"] == "brand"
    assert skill["colorStrategy"]["tier"] == "restrained"
    assert skill["theme"]["mode"] == "dark"
    assert skill["palette"]["primary"][0]["hex"] == "#5e6ad2"
    assert skill["sourceImages"] == ["skills/u/s/input-0.png"]
    assert len(bedrock.calls) == 1


def test_truncates_oversize_exemplar_summary_instead_of_failing(img_bytes):
    """Reviewer-reported failure: Haiku produced a 109-char `summary` that
    busted the schema cap. Sanitizer should truncate, not fail validation."""
    tokens = _valid_tokens()
    long_summary = (
        "Use subtle shadows (sm/md elevation) on cards and inputs; avoid drop "
        "shadows on text or illustrations and never stack three layers of soft "
        "blur on a single component when one focused depth cue is enough."
    )
    assert len(long_summary) > 200
    tokens["exemplars"] = [
        {"kind": "do", "summary": long_summary, "rationale": "Restraint."}
    ]
    bedrock = _FakeBedrock([json.dumps(tokens)])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    skill = extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="images", name="Trunc test",
        source_images_s3_keys=["skills/u/s/input-0.png"],
    )
    # Single Bedrock call — no retry, sanitization happened pre-validation.
    assert len(bedrock.calls) == 1
    truncated = skill["exemplars"][0]["summary"]
    assert len(truncated) <= 200
    assert truncated.endswith("…")


def test_tolerates_fenced_json_block(img_bytes):
    fenced = "Sure!\n```json\n" + json.dumps(_valid_tokens()) + "\n```\nAll done."
    bedrock = _FakeBedrock([fenced])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    skill = extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="images", name="n",
    )
    assert skill["styleDescriptor"]["label"] == "editorial"


def test_prompt_includes_css_token_prior(img_bytes):
    bedrock = _FakeBedrock([json.dumps(_valid_tokens())])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="url", name="n",
        css_token_prior={"colors": ["#ff0000"], "fonts": ["Inter"]},
        source_url="https://example.com",
    )
    prompt = bedrock.calls[0]["prompt"]
    assert "#ff0000" in prompt
    assert "Inter" in prompt


def test_prompt_omits_css_section_when_no_prior(img_bytes):
    bedrock = _FakeBedrock([json.dumps(_valid_tokens())])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="images", name="n",
    )
    prompt = bedrock.calls[0]["prompt"]
    assert "CSS token prior" not in prompt


def test_uses_provided_color_prior_without_computing(img_bytes):
    bedrock = _FakeBedrock([json.dumps(_valid_tokens())])

    class _DisallowMergeProcessor:
        def merge_palettes(self, *_a, **_kw):
            raise AssertionError("Should not be called when color_prior is supplied.")

    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_DisallowMergeProcessor()
    )
    extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="images", name="n",
        color_prior=[("#abcdef", 10.0)],
    )


# ---- retry paths --------------------------------------------------------


def test_retries_once_when_response_is_not_json(img_bytes):
    bedrock = _FakeBedrock(["sorry, no JSON here", json.dumps(_valid_tokens())])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    skill = extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="images", name="n",
    )
    assert skill["styleDescriptor"]["label"] == "editorial"
    assert len(bedrock.calls) == 2
    # Retry call carries the error nudge in its system prompt.
    assert "system_prompt" in bedrock.calls[1]


def test_fails_after_two_unparseable_responses(img_bytes):
    bedrock = _FakeBedrock(["no json", "still no json"])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    with pytest.raises(ExtractionError):
        extractor.extract(
            user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
            images=[img_bytes], source="images", name="n",
        )


def test_retries_once_when_schema_validation_fails(img_bytes):
    invalid = _valid_tokens()
    invalid["palette"]["primary"][0]["hex"] = "not-a-hex"
    bedrock = _FakeBedrock([json.dumps(invalid), json.dumps(_valid_tokens())])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    skill = extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="images", name="n",
    )
    assert skill["palette"]["primary"][0]["hex"] == "#5e6ad2"
    assert len(bedrock.calls) == 2


def test_fails_after_two_schema_violations(img_bytes):
    invalid = _valid_tokens()
    invalid["palette"]["primary"][0]["hex"] = "blue"
    bedrock = _FakeBedrock([json.dumps(invalid), json.dumps(invalid)])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    with pytest.raises(ExtractionError):
        extractor.extract(
            user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
            images=[img_bytes], source="images", name="n",
        )


# ---- edge cases ---------------------------------------------------------


def test_empty_images_raises(img_bytes):
    bedrock = _FakeBedrock([json.dumps(_valid_tokens())])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    with pytest.raises(ExtractionError):
        extractor.extract(
            user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
            images=[], source="images", name="n",
        )


def test_source_url_provenance_round_trips(img_bytes):
    bedrock = _FakeBedrock([json.dumps(_valid_tokens())])
    extractor = BrandTemplateExtractor(
        bedrock_client=bedrock, image_processor=_FakeImageProcessor()
    )
    skill = extractor.extract(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        images=[img_bytes], source="url", name="n",
        source_url="https://linear.app",
        source_resolved_url="https://linear.app/",
        source_screenshot_key="uploads/u/j/url-screenshot.png",
    )
    assert skill["source"] == "url"
    assert skill["sourceUrl"] == "https://linear.app"
    assert skill["sourceResolvedUrl"] == "https://linear.app/"
    assert skill["sourceScreenshotKey"] == "uploads/u/j/url-screenshot.png"
