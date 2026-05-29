"""
Build a complete, schema-valid BrandTemplate from a declared-tokens payload.

Used by the `source: 'declared'` path in lambda_function.py to produce a
skill synchronously — no Bedrock call, no self-invoke, no polling UI.

The builder is a PURE function:
  - No network I/O.
  - No time lookup — the caller supplies now_iso.
  - No mutation of inputs.

Defaults policy (matches docs/superpowers/plans/2026-05-06-brand-templates-mvp-addendum.md):
    register.kind                → "product"
    colorStrategy.tier           → "restrained"
    theme.mode                   → inferred from luminance of palette.background[0].hex
    copyVoice.forbidden          → includes "em-dashes" and "AI preamble phrases"
    motion.disallowedPatterns    → bounce, elastic, layout-property-animation
    spacing.base                 → "4px" (or user's "8px")
    typography.families.sans     → "system-ui" when absent
    styleDescriptor.label        → user's descriptorLabel, else skill name (trimmed to 40 chars)

The builder calls validate_brand_template on itself in tests to guarantee its
output always satisfies the schema. The Lambda handler ALSO runs a defensive
re-validation on the output — treat that as a belt-and-braces check, not a
substitute for the builder being correct.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional


_MAX_DESCRIPTOR_LEN = 40
_MIN_COPY_ADJECTIVES = 2
_MAX_COPY_ADJECTIVES = 6
_DEFAULT_COPY_ADJECTIVES_PAD: tuple[str, ...] = ("clear", "plain")


def build_declared_template(
    *,
    user_id: str,
    skill_id: str,
    job_id: str,
    name: str,
    description: Optional[str],
    tags: Optional[List[str]],
    tokens: Dict[str, Any],
    now_iso: str,
) -> Dict[str, Any]:
    """Return a BrandTemplate dict that passes validate_brand_template()."""
    # Defensive deep copy so we never hand our output a reference into the caller's dict.
    palette = _build_palette(copy.deepcopy(tokens["palette"]))

    families_in = tokens.get("families") or {}
    families = _build_families(families_in)
    primary_font = families.get("sans") or "system-ui"

    adjectives_in = list(tokens.get("adjectives") or [])
    style_descriptor_adjectives = _clamp_style_adjectives(adjectives_in)

    descriptor_label = _style_descriptor_label(
        declared=tokens.get("descriptorLabel"),
        name=name,
    )

    spacing_base = tokens.get("spacingBase") or "4px"
    spacing_scale = _build_spacing_scale(spacing_base)

    background_hex = tokens["palette"]["background"][0]["hex"]
    theme_mode = _infer_theme_mode(background_hex)

    border_hex = tokens["palette"]["border"][0]["hex"]

    skill: Dict[str, Any] = {
        "schemaVersion": 2,

        # identity
        "userId": user_id,
        "skillId": skill_id,
        "extractionJobId": job_id,

        # user-facing metadata
        "name": name,
        "status": "ready",
        "createdAt": now_iso,
        "updatedAt": now_iso,

        # provenance
        "source": "declared",

        # principles — sensible enterprise defaults (see docs)
        "register": {
            "kind": "product",
            "rationale": "Declared tokens with no source imagery; defaulting to product register.",
        },
        "styleDescriptor": {
            "label": descriptor_label,
            "rationale": "Tokens declared directly by the user; descriptor reflects the declared label.",
            "adjectives": style_descriptor_adjectives,
        },
        "colorStrategy": {
            "tier": "restrained",
            "accentCoveragePct": 10,
            "rationale": "Declared skill; accent coverage assumed minimal unless the user overrides later.",
        },
        "theme": {
            "mode": theme_mode,
            "sceneSentence": (
                "An employee using this application during normal working hours "
                "on a standard office monitor."
            ),
            "rationale": "Default enterprise-product scene inferred for declared skills.",
        },
        "informationHierarchy": {
            "focalOrder": [
                {
                    "rank": 1,
                    "element": "Page title",
                    "role": "Orients the user to the current workflow.",
                },
                {
                    "rank": 2,
                    "element": "Primary CTA",
                    "role": "Directs the next action in the accent color.",
                },
            ],
            "principles": [
                "Scale and weight contrast over color contrast",
                "Primary action carries the accent color; secondary actions stay neutral",
                "Generous whitespace around actionable elements",
            ],
        },
        "copyVoice": {
            "adjectives": _copy_voice_adjectives(adjectives_in),
            "case": "sentence",
            "forbidden": ["em-dashes", "AI preamble phrases"],
        },

        # tokens
        "palette": palette,
        "typography": _build_typography(families, primary_font),
        "borders": _build_borders(tokens.get("radius"), border_hex),
        "shadows": _build_shadows(),
        "spacing": {
            "base": spacing_base,
            "scale": spacing_scale,
            "rhythmNotes": (
                "Consistent padding inside cards and list rows; double-unit gap "
                "between top-level sections."
            ),
            "rhythmRules": [
                "Card padding matches the md step of the spacing scale",
                "Section gap doubles the lg step above folds",
            ],
        },
        "motion": _build_motion(),
    }

    if description:
        skill["description"] = description
    if tags:
        skill["tags"] = list(tags)

    return skill


# ----- palette ---------------------------------------------------------------


def _build_palette(palette_in: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize palette hex values to lowercase and strip unknown extra keys."""
    out: Dict[str, Any] = {}
    for bucket, entries in palette_in.items():
        out[bucket] = []
        for entry in entries:
            normalized: Dict[str, Any] = {
                "hex": str(entry["hex"]).lower(),
                "role": str(entry["role"]).strip(),
            }
            usage = entry.get("usage")
            if isinstance(usage, str) and usage.strip():
                normalized["usage"] = usage.strip()
            out[bucket].append(normalized)
    return out


# ----- typography ------------------------------------------------------------


def _build_families(families_in: Dict[str, Any]) -> Dict[str, str]:
    """Copy only the schema-allowed font-family keys."""
    allowed = ("sans", "serif", "mono", "display")
    out: Dict[str, str] = {}
    for key in allowed:
        value = families_in.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()
    if "sans" not in out:
        out["sans"] = "system-ui"
    return out


def _build_typography(families: Dict[str, str], primary_font: str) -> Dict[str, Any]:
    """A 3-step scale covers the schema's minItems=1 with reasonable coverage."""
    return {
        "scale": [
            {
                "name": "display",
                "fontFamily": primary_font,
                "fontSize": "40px",
                "fontWeight": 700,
                "lineHeight": "1.1",
            },
            {
                "name": "body",
                "fontFamily": primary_font,
                "fontSize": "16px",
                "fontWeight": 400,
                "lineHeight": "1.5",
            },
            {
                "name": "caption",
                "fontFamily": primary_font,
                "fontSize": "13px",
                "fontWeight": 400,
                "lineHeight": "1.4",
            },
        ],
        "families": dict(families),
        "principles": {
            "bodyLineLengthCh": 70,
            "scaleRatio": 1.333,
            "hierarchyStrategy": (
                "Scale and weight contrast between display, body, and caption."
            ),
        },
    }


# ----- adjectives ------------------------------------------------------------


_DEFAULT_STYLE_ADJECTIVES: tuple[str, ...] = ("corporate", "neutral", "restrained")


def _clamp_style_adjectives(supplied: List[str]) -> List[str]:
    """
    styleDescriptor.adjectives: schema requires 3..8 non-empty strings.

    If the user supplied 0..2, top up with defaults; if they supplied more than 8,
    take the first 8. Blank strings are dropped.
    """
    cleaned = [a.strip() for a in supplied if isinstance(a, str) and a.strip()]
    if len(cleaned) >= 3:
        return cleaned[:8]
    padded = cleaned + [a for a in _DEFAULT_STYLE_ADJECTIVES if a not in cleaned]
    return padded[:max(3, len(padded))][:8]


def _copy_voice_adjectives(supplied: List[str]) -> List[str]:
    """
    copyVoice.adjectives: schema requires 2..6 non-empty strings.

    Take the first entries from the user's supplied list (which mirrors the
    style adjectives). Pad with generic enterprise-copy adjectives if the
    minimum isn't met.
    """
    cleaned = [a.strip() for a in supplied if isinstance(a, str) and a.strip()]
    if _MIN_COPY_ADJECTIVES <= len(cleaned) <= _MAX_COPY_ADJECTIVES:
        return cleaned
    if len(cleaned) > _MAX_COPY_ADJECTIVES:
        return cleaned[:_MAX_COPY_ADJECTIVES]
    # pad
    padded = list(cleaned)
    for extra in _DEFAULT_COPY_ADJECTIVES_PAD:
        if extra not in padded:
            padded.append(extra)
        if len(padded) >= _MIN_COPY_ADJECTIVES:
            break
    return padded[:_MAX_COPY_ADJECTIVES]


def _style_descriptor_label(*, declared: Optional[str], name: str) -> str:
    """Prefer the user's declared label; fall back to the first 40 chars of the skill name."""
    if isinstance(declared, str) and declared.strip():
        return declared.strip()[:_MAX_DESCRIPTOR_LEN]
    return name.strip()[:_MAX_DESCRIPTOR_LEN]


# ----- spacing ---------------------------------------------------------------


def _build_spacing_scale(base: str) -> Dict[str, str]:
    """
    Scale keys are xs/sm/md/lg/xl/2xl (matches TemplateDetail render order).

    Multipliers (chosen to feel natural at both 4px and 8px bases):
      xs = 1x, sm = 2x, md = 4x, lg = 6x, xl = 8x, 2xl = 12x
    """
    multipliers = {"xs": 1, "sm": 2, "md": 4, "lg": 6, "xl": 8, "2xl": 12}
    base_px = _parse_px(base)
    return {
        key: f"{base_px * mult}px" for key, mult in multipliers.items()
    }


def _parse_px(value: str) -> int:
    """Parse '4px' or '8px' into an int. Validator already constrains the input."""
    return int(value.removesuffix("px"))


# ----- borders ---------------------------------------------------------------


def _build_borders(
    radius_in: Optional[Dict[str, Any]],
    border_hex: str,
) -> Dict[str, Any]:
    default_radius = {
        "none": "0",
        "sm": "4px",
        "md": "6px",
        "lg": "12px",
        "pill": "999px",
    }
    radius = default_radius
    if isinstance(radius_in, dict) and radius_in:
        # Merge user overrides on top of defaults so unspecified keys stay covered.
        radius = {**default_radius, **{k: str(v) for k, v in radius_in.items() if isinstance(v, str)}}
    return {
        "radius": radius,
        "width": {"hairline": "1px", "normal": "2px", "thick": "4px"},
        "color": [border_hex.lower()],
        # Enterprise-product defaults: declared skills are most often corporate
        # internal tools, which skew hairline borders + subtle radius. Users
        # can override in a later PATCH if their brand is more expressive.
        "intent": "hairline",
        "radiusIntent": "subtle",
    }


# ----- shadows ---------------------------------------------------------------


def _build_shadows() -> Dict[str, Any]:
    return {
        "elevation": [
            {
                "name": "sm",
                "value": "0 1px 2px rgba(0,0,0,0.08)",
                "description": "Hairline separation.",
            },
            {
                "name": "md",
                "value": "0 4px 12px rgba(0,0,0,0.10)",
                "description": "Card lift, dropdowns, popovers.",
            },
            {
                "name": "lg",
                "value": "0 8px 24px rgba(0,0,0,0.12)",
                "description": "Modals, dialogs.",
            },
        ],
        # Enterprise-product default: shadows communicate z-depth only, not
        # decoration. Flips to 'none' for brutalist-style declared skills
        # would require either a flag in the create request or a post-create
        # PATCH; keeping this pragmatic for MVP.
        "intent": "subtle",
    }


# ----- motion ----------------------------------------------------------------


def _build_motion() -> Dict[str, Any]:
    return {
        "tokens": [
            {
                "name": "fast",
                "duration": "120ms",
                "easing": "cubic-bezier(0.4,0,0.2,1)",
                "usage": "Hover, focus, small state changes.",
            },
            {
                "name": "default",
                "duration": "180ms",
                "easing": "cubic-bezier(0.4,0,0.2,1)",
                "usage": "Transitions, modal open/close.",
            },
        ],
        "habits": [
            "Fade over translate for appearance.",
            "No spring physics.",
            "Motion stays under 250ms.",
        ],
        "disallowedPatterns": ["bounce", "elastic", "layout-property-animation"],
    }


# ----- theme inference -------------------------------------------------------


def _infer_theme_mode(background_hex: str) -> str:
    """
    sRGB relative luminance per WCAG, threshold at 0.5.

    background_hex format is guaranteed by the validator to be #rrggbb.
    """
    r = int(background_hex[1:3], 16) / 255.0
    g = int(background_hex[3:5], 16) / 255.0
    b = int(background_hex[5:7], 16) / 255.0

    def _lin(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    luminance = 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)
    return "light" if luminance >= 0.5 else "dark"
