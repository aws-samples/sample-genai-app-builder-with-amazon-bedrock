"""
Safe public-URL fetcher for the URL-input extraction path.

Responsibilities:
  * Validate URL scheme (https only) and resolve hostname.
  * Reject any address that resolves to a private, loopback, link-local,
    multicast, CGNAT, or AWS-metadata IP range.
  * Fetch HTML with strict size/time caps.
  * Fetch linked same-origin stylesheets under an aggregate cap.
  * Extract design tokens (colors, fonts, radii, shadows, CSS vars) with
    tinycss2.
  * Grab the first reachable OG image or favicon as a palette seed.

All network access goes through the shared SSRF-safe fetcher (safe_fetch.py):
DNS is resolved inside the Lambda and every answer is validated before each
hop (including redirects), and the socket is opened against the validated
IP while TLS SNI / certificate checks and the Host header keep the original
hostname (defeats DNS rebinding).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urljoin

import tinycss2

from safe_fetch import (
    PinnedTarget,
    UrlFetchError,
    UrlRejectedError,
    default_resolver,
    safe_get,
    validate_url,
)

__all__ = [
    "UrlFetchError",
    "UrlRejectedError",
    "UrlRenderer",
    "UrlTokens",
    "extract_css_tokens",
]


# Hard caps — every one of these is enforced before any read from the wire.
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_CSS_BYTES_PER_FILE = 1 * 1024 * 1024
MAX_CSS_BYTES_AGGREGATE = 3 * 1024 * 1024
MAX_IMAGE_BYTES = 512 * 1024
MAX_REDIRECTS = 3
CONNECT_TIMEOUT_SEC = 5
READ_TIMEOUT_SEC = 10
TOTAL_BUDGET_SEC = 20

_ALLOWED_CSS_MIME = {"text/css"}
_ALLOWED_IMAGE_MIME_PREFIX = "image/"
_ALLOWED_HTML_MIME = {"text/html", "application/xhtml+xml"}
_ALLOWED_HTML_MIME_STARTSWITH = ("text/html",)

_USER_AGENT = "bedrock-vibe-design-skills/1.0"

@dataclass
class UrlTokens:
    colors: List[str] = field(default_factory=list)
    fonts: List[str] = field(default_factory=list)
    font_sizes: List[str] = field(default_factory=list)
    border_radii: List[str] = field(default_factory=list)
    box_shadows: List[str] = field(default_factory=list)
    css_vars: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, object]:
        return {
            "colors": list(self.colors),
            "fonts": list(self.fonts),
            "font-sizes": list(self.font_sizes),
            "border-radius": list(self.border_radii),
            "box-shadow": list(self.box_shadows),
            "css-vars": dict(self.css_vars),
        }


class UrlRenderer:
    def __init__(
        self,
        *,
        dns_resolver: Optional[Callable[[str], List[str]]] = None,
    ) -> None:
        self._dns_resolver = dns_resolver or default_resolver

    # ---- validation ----------------------------------------------------

    def validate(self, url: str) -> PinnedTarget:
        """Validate scheme, resolve hostname, reject disallowed IPs.

        Returns the target pinned to the validated IP. Raises UrlRejectedError.
        """
        return validate_url(url, resolver=self._dns_resolver, allowed_schemes=("https",))

    # ---- fetchers ------------------------------------------------------

    def fetch_html(self, url: str) -> Tuple[str, List[str], str]:
        """
        Fetch HTML. Returns (body, linked_stylesheet_urls, final_url).
        Raises UrlRejectedError / UrlFetchError. Validation happens inside
        _bounded_get (once per hop) so there is no separate check-then-fetch.
        """
        body, final_url = self._bounded_get(
            url,
            allowed_mime_startswith=_ALLOWED_HTML_MIME_STARTSWITH,
            max_bytes=MAX_HTML_BYTES,
        )
        html = body.decode("utf-8", errors="replace")
        css_urls = _extract_stylesheet_links(html, final_url)
        return html, css_urls, final_url

    def fetch_stylesheets(self, css_urls: Iterable[str]) -> List[str]:
        """
        Fetch up to MAX_CSS_BYTES_AGGREGATE of CSS across `css_urls`,
        per-file cap MAX_CSS_BYTES_PER_FILE. Each URL is re-validated.
        """
        aggregate = 0
        out: List[str] = []
        for css_url in css_urls:
            if aggregate >= MAX_CSS_BYTES_AGGREGATE:
                break
            remaining = MAX_CSS_BYTES_AGGREGATE - aggregate
            cap = min(MAX_CSS_BYTES_PER_FILE, remaining)
            try:
                body, _ = self._bounded_get(
                    css_url,
                    allowed_mime_startswith=("text/css",),
                    max_bytes=cap,
                )
            except (UrlFetchError, UrlRejectedError):
                continue
            aggregate += len(body)
            out.append(body.decode("utf-8", errors="replace"))
        return out

    def fetch_favicon_and_og(self, html: str, base_url: str) -> Optional[bytes]:
        """
        Return raster image bytes (PNG/JPEG/GIF/WebP) for the first reachable
        OG image or favicon, or None if nothing usable is available.

        SVG + ICO + AVIF are skipped: Pillow can't decode SVG at all, ICO
        containers often have embedded BMP that fails Pillow's content-sniff,
        and AVIF needs a plugin the Lambda layer doesn't ship. Rather than
        error when we encounter them, we move on to the next candidate and
        ultimately let the caller fall back to a palette-placeholder swatch.
        """
        allowed_raster = (
            "image/png",
            "image/jpeg",
            "image/jpg",
            "image/gif",
            "image/webp",
        )
        candidates = _extract_image_candidates(html, base_url)
        for img_url in candidates:
            try:
                body, _ = self._bounded_get(
                    img_url,
                    allowed_mime_startswith=allowed_raster,
                    max_bytes=MAX_IMAGE_BYTES,
                )
                return body
            except (UrlFetchError, UrlRejectedError):
                continue
        return None

    # ---- bounded GET ---------------------------------------------------

    def _bounded_get(
        self,
        url: str,
        *,
        allowed_mime_startswith: Tuple[str, ...],
        max_bytes: int,
    ) -> Tuple[bytes, str]:
        """
        GET a URL with strict caps via the shared SSRF-safe fetcher: every hop
        (including up to MAX_REDIRECTS redirects) is re-validated and the
        connection is pinned to the validated IP with TLS verification on.
        """
        result = safe_get(
            url,
            resolver=self._dns_resolver,
            allowed_schemes=("https",),
            allowed_mime_startswith=allowed_mime_startswith,
            max_bytes=max_bytes,
            max_redirects=MAX_REDIRECTS,
            connect_timeout=CONNECT_TIMEOUT_SEC,
            read_timeout=READ_TIMEOUT_SEC,
            total_budget=TOTAL_BUDGET_SEC,
            headers={"User-Agent": _USER_AGENT},
        )
        return result.body, result.final_url


# ---- CSS token extraction -----------------------------------------------


def extract_css_tokens(css: str) -> UrlTokens:
    """Parse a CSS blob and collect design tokens."""
    tokens = UrlTokens()
    if not css:
        return tokens

    rules = tinycss2.parse_stylesheet(css, skip_comments=True, skip_whitespace=True)
    for rule in rules:
        if rule.type != "qualified-rule" and getattr(rule, "type", None) != "at-rule":
            continue
        content = getattr(rule, "content", None) or []
        declarations = tinycss2.parse_declaration_list(content, skip_comments=True, skip_whitespace=True)
        _collect_from_declarations(declarations, tokens)

    # Dedupe while preserving order.
    tokens.colors = _dedupe(tokens.colors)
    tokens.fonts = _dedupe(tokens.fonts)
    tokens.font_sizes = _dedupe(tokens.font_sizes)
    tokens.border_radii = _dedupe(tokens.border_radii)
    tokens.box_shadows = _dedupe(tokens.box_shadows)
    return tokens


def _collect_from_declarations(declarations, tokens: UrlTokens) -> None:
    for decl in declarations:
        if decl.type != "declaration":
            continue
        name = decl.name.lower()
        value = tinycss2.serialize(decl.value).strip()
        if not value:
            continue

        if name.startswith("--"):
            tokens.css_vars[name] = value
        if name in {"color", "background-color", "background", "border-color", "fill", "stroke"}:
            for color in _extract_colors_from_value(value):
                tokens.colors.append(color)
        if name in {"font-family"}:
            tokens.fonts.append(value)
        if name in {"font-size"}:
            tokens.font_sizes.append(value)
        if name in {"border-radius"}:
            tokens.border_radii.append(value)
        if name in {"box-shadow"}:
            tokens.box_shadows.append(value)


_HEX_RE = re.compile(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
_RGB_RE = re.compile(
    r"rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+)?\s*\)"
)


def _extract_colors_from_value(value: str) -> List[str]:
    out: List[str] = []
    for m in _HEX_RE.finditer(value):
        h = m.group(1).lower()
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 8:
            h = h[:6]  # drop alpha
        out.append(f"#{h}")
    for m in _RGB_RE.finditer(value):
        r, g, b = (max(0, min(255, int(v))) for v in m.groups())
        out.append("#{:02x}{:02x}{:02x}".format(r, g, b))
    return out


def _dedupe(seq: Iterable[str]) -> List[str]:
    seen: Set[str] = set()
    out: List[str] = []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# ---- HTML helpers (no BeautifulSoup dep — regex is enough for what we need) ----


_LINK_RE = re.compile(
    r"<link\b[^>]*?\brel\s*=\s*['\"]([^'\"]+)['\"][^>]*?\bhref\s*=\s*['\"]([^'\"]+)['\"]",
    re.IGNORECASE | re.DOTALL,
)
_LINK_RE_HREF_FIRST = re.compile(
    r"<link\b[^>]*?\bhref\s*=\s*['\"]([^'\"]+)['\"][^>]*?\brel\s*=\s*['\"]([^'\"]+)['\"]",
    re.IGNORECASE | re.DOTALL,
)
_META_OG_RE = re.compile(
    r"<meta\b[^>]*?\bproperty\s*=\s*['\"]og:image['\"][^>]*?\bcontent\s*=\s*['\"]([^'\"]+)['\"]",
    re.IGNORECASE | re.DOTALL,
)


def _extract_stylesheet_links(html: str, base_url: str) -> List[str]:
    urls: List[str] = []
    for m in _LINK_RE.finditer(html):
        rel, href = m.group(1).lower(), m.group(2)
        if "stylesheet" in rel:
            urls.append(urljoin(base_url, href))
    for m in _LINK_RE_HREF_FIRST.finditer(html):
        href, rel = m.group(1), m.group(2).lower()
        if "stylesheet" in rel:
            urls.append(urljoin(base_url, href))
    return _dedupe(urls)


def _extract_image_candidates(html: str, base_url: str) -> List[str]:
    out: List[str] = []
    for m in _META_OG_RE.finditer(html):
        out.append(urljoin(base_url, m.group(1)))
    for m in _LINK_RE.finditer(html):
        rel, href = m.group(1).lower(), m.group(2)
        if "icon" in rel:
            out.append(urljoin(base_url, href))
    # Always probe /favicon.ico as a last resort.
    out.append(urljoin(base_url, "/favicon.ico"))
    return _dedupe(out)
