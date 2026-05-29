"""
BrandTemplateExtractor — orchestrates a single enriched extraction pass.

Flow:
    1. If no color_prior was supplied, compute it via ImageProcessor.merge_palettes.
    2. Render the extraction prompt with the color/CSS priors.
    3. Call Bedrock.converse(images, prompt).
    4. Parse the JSON reply (tolerating fenced blocks).
    5. Merge parsed tokens with identity/provenance fields into a full skill.
    6. Validate against the JSON schema; retry once with an error-aware nudge.
    7. Return the validated skill.

The retry path exists because Claude occasionally emits extra prose around
a valid JSON object. One retry with the error message as an additional
system prompt clears >95% of residual failures in practice.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from schema import SchemaValidationError, validate_brand_template


class ExtractionError(RuntimeError):
    """Raised when the extractor cannot produce a schema-valid skill."""


_PROMPT_TEMPLATE = (Path(__file__).parent / "prompts" / "extract.md").read_text()

_SCHEMA_VERSION = 2


class BrandTemplateExtractor:
    def __init__(
        self,
        *,
        bedrock_client,
        image_processor,
    ) -> None:
        self._bedrock = bedrock_client
        self._image_processor = image_processor

    def extract(
        self,
        *,
        user_id: str,
        skill_id: str,
        job_id: str,
        images: Sequence[bytes],
        source: str,
        name: str,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
        source_images_s3_keys: Optional[Sequence[str]] = None,
        source_url: Optional[str] = None,
        source_resolved_url: Optional[str] = None,
        source_screenshot_key: Optional[str] = None,
        css_token_prior: Optional[Mapping[str, Any]] = None,
        color_prior: Optional[List[tuple]] = None,
    ) -> Dict[str, Any]:
        if not images:
            raise ExtractionError("At least one image is required.")

        if color_prior is None:
            color_prior = self._image_processor.merge_palettes(images)

        prompt = _render_prompt(
            image_count=len(images),
            source=source,
            color_prior=color_prior,
            css_token_prior=css_token_prior,
        )

        # First attempt.
        raw = self._bedrock.converse(images=list(images), prompt=prompt)
        parsed, parse_err = _parse_json(raw)

        # Retry once with error-aware nudge if parse or validation failed.
        if parsed is None:
            raw = self._bedrock.converse(
                images=list(images),
                prompt=prompt,
                system_prompt=_retry_system_prompt(parse_err or "The response was not valid JSON."),
            )
            parsed, parse_err = _parse_json(raw)
            if parsed is None:
                raise ExtractionError(f"Bedrock returned invalid JSON: {parse_err}")

        skill = _assemble_skill(
            tokens=parsed,
            user_id=user_id,
            skill_id=skill_id,
            job_id=job_id,
            name=name,
            description=description,
            tags=tags,
            source=source,
            source_images=source_images_s3_keys,
            source_url=source_url,
            source_resolved_url=source_resolved_url,
            source_screenshot_key=source_screenshot_key,
        )
        # Filter closed-enum values BEFORE validation — clears the most
        # common 'invented pattern name' failures without a Bedrock retry.
        _sanitize_closed_enums(skill)

        try:
            validate_brand_template(skill)
            return skill
        except SchemaValidationError as first_err:
            # Retry once with the schema error in the system prompt.
            raw = self._bedrock.converse(
                images=list(images),
                prompt=prompt,
                system_prompt=_retry_system_prompt(str(first_err)),
            )
            parsed, parse_err = _parse_json(raw)
            if parsed is None:
                raise ExtractionError(
                    f"Retry returned invalid JSON: {parse_err}"
                ) from first_err
            skill = _assemble_skill(
                tokens=parsed,
                user_id=user_id,
                skill_id=skill_id,
                job_id=job_id,
                name=name,
                description=description,
                tags=tags,
                source=source,
                source_images=source_images_s3_keys,
                source_url=source_url,
                source_resolved_url=source_resolved_url,
                source_screenshot_key=source_screenshot_key,
            )
            _sanitize_closed_enums(skill)
            try:
                validate_brand_template(skill)
                return skill
            except SchemaValidationError as retry_err:
                raise ExtractionError(
                    f"Schema validation failed twice: {retry_err}"
                ) from retry_err


# ---- helpers ---------------------------------------------------------------


def _render_prompt(
    *,
    image_count: int,
    source: str,
    color_prior: Sequence[tuple],
    css_token_prior: Optional[Mapping[str, Any]],
) -> str:
    if color_prior:
        color_lines = "\n".join(
            f"- {hex_val} ({pct:.1f}%)" for hex_val, pct in color_prior
        )
    else:
        color_lines = "- (no prior — infer from images)"

    if css_token_prior:
        css_json = json.dumps(css_token_prior, indent=2, sort_keys=True)
        css_section = (
            "A CSS token prior from the public URL's stylesheets. Prefer these tokens "
            "when they don't conflict with the image evidence:\n\n"
            f"```json\n{css_json}\n```"
        )
    else:
        css_section = ""

    source_note = {
        "images": "",
        "url": " and the linked screenshot from a public URL",
    }.get(source, "")

    return (
        _PROMPT_TEMPLATE.replace("{{image_count}}", str(image_count))
        .replace("{{source_note}}", source_note)
        .replace("{{color_prior}}", color_lines)
        .replace("{{css_token_prior}}", css_section)
    )


_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_FIRST_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_json(raw: str) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Extract a JSON object from the reply. Returns (parsed, error_message)."""
    if not raw or not raw.strip():
        return None, "Empty response."

    # Strip a fenced block first.
    m = _FENCE_RE.search(raw)
    candidate = m.group(1) if m else raw

    # Fall back to the first { ... } pair.
    try:
        return json.loads(candidate), None
    except json.JSONDecodeError:
        pass

    m2 = _FIRST_OBJ_RE.search(candidate)
    if m2:
        try:
            return json.loads(m2.group(0)), None
        except json.JSONDecodeError as e:
            return None, f"{e.msg} at line {e.lineno} col {e.colno}"
    return None, "No JSON object found in response."


def _retry_system_prompt(err: str) -> str:
    return (
        "Your previous output was rejected: " + err + "\n"
        "Re-emit a single valid JSON object that matches the schema exactly. "
        "No prose, no code fences, no trailing commas.\n"
        "CLOSED ENUMS you must obey (do not invent new values):\n"
        "  - motion.disallowedPatterns items: one of "
        "['bounce', 'elastic', 'layout-property-animation', 'linear-easing', "
        "'springs', 'flashing-above-3hz'].\n"
        "  - antiReferences.bansObserved items: one of "
        "['side-stripe-border', 'gradient-text', 'decorative-glassmorphism', "
        "'hero-metric-template', 'identical-card-grids', "
        "'modal-as-first-thought', 'em-dashes'].\n"
        "  - register.kind: 'brand' or 'product'.\n"
        "  - colorStrategy.tier: 'restrained', 'committed', 'full-palette', 'drenched'.\n"
        "  - theme.mode: 'light' or 'dark'.\n"
        "  - copyVoice.case: 'sentence', 'title', 'mixed', 'all-caps', 'lowercase'.\n"
        "  - copyVoice.density: 'sparse', 'balanced', 'dense'.\n"
        "If a concept doesn't fit a listed value, either pick the closest "
        "member or omit the entry — do not invent a new label."
    )


# Enum guards match the schema's closed enum lists. If the model invents a
# new value (it sometimes tries to be 'creative' with motion patterns), we
# drop the unknown entries rather than fail validation — the model will
# otherwise retry, get the same invention again, and waste 90s before
# surfacing an opaque failure to the user.
_ALLOWED_MOTION_DISALLOWED = frozenset({
    "bounce",
    "elastic",
    "layout-property-animation",
    "linear-easing",
    "springs",
    "flashing-above-3hz",
})
_ALLOWED_ANTI_BANS = frozenset({
    "side-stripe-border",
    "gradient-text",
    "decorative-glassmorphism",
    "hero-metric-template",
    "identical-card-grids",
    "modal-as-first-thought",
    "em-dashes",
})


def _sanitize_closed_enums(skill: Dict[str, Any]) -> None:
    """
    Drop out-of-enum values from closed-list fields in-place.

    These enums are the most common source of 'Schema validation failed
    twice' because the model occasionally invents new pattern names (e.g.
    'infinite-spin-without-purpose'). Filtering here preserves the rest of
    the payload and lets validation succeed on the first attempt.
    """
    motion = skill.get("motion")
    if isinstance(motion, dict):
        disallowed = motion.get("disallowedPatterns")
        if isinstance(disallowed, list):
            motion["disallowedPatterns"] = [
                v for v in disallowed if v in _ALLOWED_MOTION_DISALLOWED
            ]
            # Ensure the three schema-mandated entries are present so we don't
            # flip from 'model invented' to 'model omitted required items'.
            required_min = {"bounce", "elastic", "layout-property-animation"}
            for entry in required_min:
                if entry not in motion["disallowedPatterns"]:
                    motion["disallowedPatterns"].append(entry)

    anti = skill.get("antiReferences")
    if isinstance(anti, dict):
        bans = anti.get("bansObserved")
        if isinstance(bans, list):
            anti["bansObserved"] = [v for v in bans if v in _ALLOWED_ANTI_BANS]

    # Truncate exemplar strings to schema caps. Haiku occasionally writes
    # 110-160 char `summary` lines that bust the 200-char ceiling; rather
    # than failing the whole extraction over a soft length issue, trim and
    # carry on. Same defense for `rationale`. We slice on a word boundary
    # where convenient so the truncated string still reads naturally.
    exemplars = skill.get("exemplars")
    if isinstance(exemplars, list):
        for ex in exemplars:
            if not isinstance(ex, dict):
                continue
            for field, cap in (("summary", 200), ("rationale", 300)):
                value = ex.get(field)
                if isinstance(value, str) and len(value) > cap:
                    cut = value[:cap].rsplit(" ", 1)[0] if " " in value[:cap] else value[:cap]
                    # Don't strand a trailing punctuation mid-sentence.
                    ex[field] = cut.rstrip(",;: ") + "…"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _assemble_skill(
    *,
    tokens: Mapping[str, Any],
    user_id: str,
    skill_id: str,
    job_id: str,
    name: str,
    description: Optional[str],
    tags: Optional[List[str]],
    source: str,
    source_images: Optional[Sequence[str]],
    source_url: Optional[str],
    source_resolved_url: Optional[str],
    source_screenshot_key: Optional[str],
) -> Dict[str, Any]:
    now = _now_iso()
    skill: Dict[str, Any] = {
        "schemaVersion": _SCHEMA_VERSION,
        "userId": user_id,
        "skillId": skill_id,
        "extractionJobId": job_id,
        "name": name,
        "status": "ready",
        "createdAt": now,
        "updatedAt": now,
        "source": source,
        "register": tokens.get("register"),
        "styleDescriptor": tokens.get("styleDescriptor"),
        "colorStrategy": tokens.get("colorStrategy"),
        "theme": tokens.get("theme"),
        "informationHierarchy": tokens.get("informationHierarchy"),
        "copyVoice": tokens.get("copyVoice"),
        "palette": tokens.get("palette"),
        "typography": tokens.get("typography"),
        "borders": tokens.get("borders"),
        "shadows": tokens.get("shadows"),
        "spacing": tokens.get("spacing"),
        "motion": tokens.get("motion"),
    }
    anti_refs = tokens.get("antiReferences")
    if anti_refs:
        skill["antiReferences"] = anti_refs
    if description:
        skill["description"] = description
    if tags:
        skill["tags"] = list(tags)
    if source_images:
        skill["sourceImages"] = list(source_images)
    if source_url:
        skill["sourceUrl"] = source_url
    if source_resolved_url:
        skill["sourceResolvedUrl"] = source_resolved_url
    if source_screenshot_key:
        skill["sourceScreenshotKey"] = source_screenshot_key
    exemplars = tokens.get("exemplars")
    if exemplars:
        skill["exemplars"] = exemplars
    return skill
