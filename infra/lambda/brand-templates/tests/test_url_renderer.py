"""Functional tests for UrlRenderer HTTP/CSS/image fetchers, using requests-mock."""

from __future__ import annotations

import pytest

from url_renderer import (  # type: ignore[import-not-found]
    MAX_CSS_BYTES_AGGREGATE,
    MAX_CSS_BYTES_PER_FILE,
    MAX_HTML_BYTES,
    UrlFetchError,
    UrlRenderer,
    extract_css_tokens,
)


PUBLIC_IP = "93.184.216.34"


def _renderer():
    return UrlRenderer(dns_resolver=lambda host: [PUBLIC_IP])


# ---- fetch_html ---------------------------------------------------------


def test_fetch_html_returns_body_and_stylesheet_links(requests_mock):
    html = """
    <html>
      <head>
        <link rel="stylesheet" href="/site.css">
        <link rel="preload" href="/ignore.js">
        <link rel="icon" href="/favicon.ico">
      </head>
      <body>Hi</body>
    </html>
    """
    requests_mock.get(
        "https://example.com/",
        text=html,
        headers={"Content-Type": "text/html; charset=utf-8"},
    )
    body, css_urls, final_url = _renderer().fetch_html("https://example.com/")
    assert "Hi" in body
    assert css_urls == ["https://example.com/site.css"]
    assert final_url == "https://example.com/"


def test_fetch_html_rejects_non_html(requests_mock):
    requests_mock.get(
        "https://example.com/",
        text="plain",
        headers={"Content-Type": "text/plain"},
    )
    with pytest.raises(UrlFetchError):
        _renderer().fetch_html("https://example.com/")


def test_fetch_html_follows_redirects_up_to_cap(requests_mock):
    requests_mock.get(
        "https://example.com/a",
        status_code=301,
        headers={"Location": "https://example.com/b"},
    )
    requests_mock.get(
        "https://example.com/b",
        status_code=301,
        headers={"Location": "https://example.com/c"},
    )
    requests_mock.get(
        "https://example.com/c",
        text="ok",
        headers={"Content-Type": "text/html"},
    )
    body, _, final = _renderer().fetch_html("https://example.com/a")
    assert body == "ok"
    assert final == "https://example.com/c"


def test_fetch_html_rejects_too_many_redirects(requests_mock):
    for i in range(5):
        requests_mock.get(
            f"https://example.com/{i}",
            status_code=301,
            headers={"Location": f"https://example.com/{i + 1}"},
        )
    with pytest.raises(UrlFetchError):
        _renderer().fetch_html("https://example.com/0")


def test_fetch_html_rejects_oversize(requests_mock):
    body = "<html>" + "x" * (MAX_HTML_BYTES + 100) + "</html>"
    requests_mock.get(
        "https://example.com/",
        text=body,
        headers={"Content-Type": "text/html"},
    )
    with pytest.raises(UrlFetchError):
        _renderer().fetch_html("https://example.com/")


def test_fetch_html_rejects_4xx(requests_mock):
    requests_mock.get(
        "https://example.com/",
        status_code=404,
        text="nope",
        headers={"Content-Type": "text/html"},
    )
    with pytest.raises(UrlFetchError):
        _renderer().fetch_html("https://example.com/")


# ---- fetch_stylesheets --------------------------------------------------


def test_fetch_stylesheets_aggregates_under_cap(requests_mock):
    requests_mock.get(
        "https://example.com/a.css",
        text=":root { --x: 1 }",
        headers={"Content-Type": "text/css"},
    )
    requests_mock.get(
        "https://example.com/b.css",
        text=".x { color: red }",
        headers={"Content-Type": "text/css"},
    )
    sheets = _renderer().fetch_stylesheets(
        ["https://example.com/a.css", "https://example.com/b.css"]
    )
    assert len(sheets) == 2
    assert "--x" in sheets[0]
    assert "color: red" in sheets[1]


def test_fetch_stylesheets_skips_failed_urls(requests_mock):
    requests_mock.get(
        "https://example.com/a.css",
        status_code=404,
        headers={"Content-Type": "text/css"},
    )
    requests_mock.get(
        "https://example.com/b.css",
        text=".x { color: red }",
        headers={"Content-Type": "text/css"},
    )
    sheets = _renderer().fetch_stylesheets(
        ["https://example.com/a.css", "https://example.com/b.css"]
    )
    assert sheets == [".x { color: red }"]


def test_fetch_stylesheets_enforces_per_file_cap(requests_mock):
    big = "a" * (MAX_CSS_BYTES_PER_FILE + 10)
    requests_mock.get(
        "https://example.com/big.css",
        text=big,
        headers={"Content-Type": "text/css"},
    )
    sheets = _renderer().fetch_stylesheets(["https://example.com/big.css"])
    assert sheets == []  # skipped after per-file cap exceeded


def test_fetch_stylesheets_rejects_non_css_mime(requests_mock):
    requests_mock.get(
        "https://example.com/a.css",
        text=".x{}",
        headers={"Content-Type": "text/html"},
    )
    assert _renderer().fetch_stylesheets(["https://example.com/a.css"]) == []


# ---- fetch_favicon_and_og -----------------------------------------------


def test_fetch_favicon_and_og_prefers_og_image(requests_mock):
    html = """
    <meta property="og:image" content="/social.png">
    <link rel="icon" href="/favicon.ico">
    """
    requests_mock.get(
        "https://example.com/social.png",
        content=b"\x89PNG\r\n\x1a\n" + b"x" * 10,
        headers={"Content-Type": "image/png"},
    )
    img = _renderer().fetch_favicon_and_og(html, "https://example.com/")
    assert img is not None
    assert img.startswith(b"\x89PNG")


def test_fetch_favicon_and_og_falls_back_to_favicon(requests_mock):
    html = "<html><head></head><body></body></html>"
    requests_mock.get(
        "https://example.com/favicon.ico",
        content=b"\x00\x00\x01\x00" + b"x" * 10,
        headers={"Content-Type": "image/vnd.microsoft.icon"},
    )
    img = _renderer().fetch_favicon_and_og(html, "https://example.com/")
    assert img is not None
    assert img.startswith(b"\x00\x00\x01\x00")


def test_fetch_favicon_and_og_returns_none_when_nothing_reachable(requests_mock):
    html = "<html></html>"
    requests_mock.get(
        "https://example.com/favicon.ico",
        status_code=404,
        headers={"Content-Type": "image/png"},
    )
    assert _renderer().fetch_favicon_and_og(html, "https://example.com/") is None


# ---- extract_css_tokens -------------------------------------------------


def test_extract_css_tokens_collects_colors_fonts_sizes_radii_shadows():
    css = """
      :root {
        --brand: #5e6ad2;
        --bg: rgb(11, 14, 22);
      }
      body {
        color: #5e6ad2;
        background-color: rgba(11, 14, 22, 0.9);
        font-family: "Inter", system-ui;
        font-size: 16px;
      }
      .card {
        border-radius: 12px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      }
    """
    t = extract_css_tokens(css)
    assert "#5e6ad2" in t.colors
    assert any("Inter" in f for f in t.fonts)
    assert "16px" in t.font_sizes
    assert "12px" in t.border_radii
    assert any("rgba" in s for s in t.box_shadows)
    assert t.css_vars.get("--brand") == "#5e6ad2"


def test_extract_css_tokens_empty_input_returns_empty_struct():
    t = extract_css_tokens("")
    assert t.colors == []
    assert t.css_vars == {}
