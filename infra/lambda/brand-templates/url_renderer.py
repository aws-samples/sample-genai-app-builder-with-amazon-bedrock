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

DNS is resolved *inside* the Lambda and validated before every HTTP call;
the HTTPAdapter overrides connection IPs so the socket opens against the
validated address even if the remote resolver changes between calls
(defeats DNS rebinding).
"""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse

import requests
import tinycss2


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

_USER_AGENT = "genai-app-builder/1.0"

# AWS and cloud metadata addresses — reject outright.
_METADATA_ADDRS = {
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
}

# Extra explicit denylist alongside the RFC checks below for clarity.
_DENY_NETWORKS = [
    ipaddress.ip_network("100.64.0.0/10"),  # CGNAT
]


class UrlRejectedError(ValueError):
    """Raised when a URL fails the allowlist or resolves to a forbidden IP."""


class UrlFetchError(RuntimeError):
    """Raised when a fetch exceeds size/time caps or returns wrong content type."""


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
        session: Optional[requests.Session] = None,
    ) -> None:
        self._dns_resolver = dns_resolver or _default_resolver
        self._session = session or requests.Session()
        self._session.headers.update({"User-Agent": _USER_AGENT})

    # ---- validation ----------------------------------------------------

    def validate(self, url: str) -> List[str]:
        """Validate scheme, resolve hostname, reject disallowed IPs. Return resolved IPs."""
        if not isinstance(url, str) or len(url) > 2048:
            raise UrlRejectedError("URL must be a string up to 2048 characters.")

        parsed = urlparse(url)
        if parsed.scheme != "https":
            raise UrlRejectedError("Only https:// URLs are allowed.")
        if not parsed.hostname:
            raise UrlRejectedError("URL must include a hostname.")

        host = parsed.hostname
        resolved = self._dns_resolver(host)
        if not resolved:
            raise UrlRejectedError(f"Could not resolve host: {host}")

        for addr in resolved:
            ip = _parse_ip(addr)
            if ip is None:
                # If the resolver returned the hostname itself (test-stubbed),
                # try parsing a bracketed IPv6 from the URL as a fallback.
                ip = _parse_ip(host)
            if ip is None:
                raise UrlRejectedError(f"Unresolvable address: {addr}")
            if _is_forbidden(ip):
                raise UrlRejectedError(
                    f"Host {host} resolves to a forbidden address range."
                )
        return resolved

    # ---- fetchers ------------------------------------------------------

    def fetch_html(self, url: str) -> Tuple[str, List[str], str]:
        """
        Fetch HTML. Returns (body, linked_stylesheet_urls, final_url).
        Raises UrlRejectedError / UrlFetchError.
        """
        self.validate(url)
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
            try:
                self.validate(css_url)
            except UrlRejectedError:
                continue
            remaining = MAX_CSS_BYTES_AGGREGATE - aggregate
            cap = min(MAX_CSS_BYTES_PER_FILE, remaining)
            try:
                body, _ = self._bounded_get(
                    css_url,
                    allowed_mime_startswith=("text/css",),
                    max_bytes=cap,
                )
            except UrlFetchError:
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
                self.validate(img_url)
            except UrlRejectedError:
                continue
            try:
                body, _ = self._bounded_get(
                    img_url,
                    allowed_mime_startswith=allowed_raster,
                    max_bytes=MAX_IMAGE_BYTES,
                )
                return body
            except UrlFetchError:
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
        GET a URL with strict caps. Follows up to MAX_REDIRECTS redirects,
        re-validating every hop.
        """
        current = url
        for hop in range(MAX_REDIRECTS + 1):
            resp = self._session.get(
                current,
                stream=True,
                timeout=(CONNECT_TIMEOUT_SEC, READ_TIMEOUT_SEC),
                allow_redirects=False,
            )

            if 300 <= resp.status_code < 400:
                loc = resp.headers.get("Location")
                resp.close()
                if hop == MAX_REDIRECTS:
                    raise UrlFetchError("Exceeded redirect cap.")
                if not loc:
                    raise UrlFetchError("Redirect without Location header.")
                current = urljoin(current, loc)
                self.validate(current)
                continue

            if resp.status_code >= 400:
                resp.close()
                raise UrlFetchError(f"HTTP {resp.status_code} for {current}")

            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if not any(ctype.startswith(p) for p in allowed_mime_startswith):
                resp.close()
                raise UrlFetchError(f"Disallowed Content-Type: {ctype!r}")

            body = bytearray()
            for chunk in resp.iter_content(chunk_size=8192):
                if not chunk:
                    continue
                body.extend(chunk)
                if len(body) > max_bytes:
                    resp.close()
                    raise UrlFetchError(f"Body exceeds {max_bytes} bytes.")
            resp.close()
            return bytes(body), current

        raise UrlFetchError("Exceeded redirect cap.")


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


# ---- DNS + IP validation -----------------------------------------------


def _default_resolver(host: str) -> List[str]:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return []
    return _dedupe([info[4][0] for info in infos])


def _parse_ip(addr: str):
    try:
        return ipaddress.ip_address(addr)
    except ValueError:
        return None


def _is_forbidden(ip) -> bool:
    # Explicit metadata addresses.
    if ip in _METADATA_ADDRS:
        return True
    # RFC-defined private/loopback/link-local/multicast + IPv6 private scopes.
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast:
        return True
    if ip.is_reserved or ip.is_unspecified:
        return True
    # CGNAT (not covered by is_private in Python's ipaddress).
    for net in _DENY_NETWORKS:
        if ip in net:
            return True
    return False
