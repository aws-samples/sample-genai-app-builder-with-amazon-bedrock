"""SSRF-focused tests for the URL renderer's validation layer."""

from __future__ import annotations

import pytest

from url_renderer import UrlRejectedError, UrlRenderer  # type: ignore[import-not-found]


def _renderer_with_ips(ips):
    return UrlRenderer(dns_resolver=lambda host: list(ips))


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",                # wrong scheme
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hi",
        "ftp://example.com",
    ],
)
def test_rejects_disallowed_scheme(url):
    r = _renderer_with_ips(["93.184.216.34"])
    with pytest.raises(UrlRejectedError):
        r.validate(url)


@pytest.mark.parametrize(
    "ip",
    [
        "169.254.169.254",   # EC2 metadata
        "127.0.0.1",          # loopback
        "10.0.0.5",           # RFC 1918
        "172.20.0.5",
        "192.168.1.1",
        "100.64.0.1",         # CGNAT
        "::1",                # IPv6 loopback
        "fe80::1",            # IPv6 link-local
        "fd00::1",            # IPv6 private
        "224.0.0.1",          # multicast
    ],
)
def test_rejects_private_or_metadata_resolved_ip(ip):
    r = _renderer_with_ips([ip])
    with pytest.raises(UrlRejectedError):
        r.validate("https://evil.example.com")


def test_rejects_metadata_direct_in_url():
    r = _renderer_with_ips(["169.254.169.254"])
    with pytest.raises(UrlRejectedError):
        r.validate("https://169.254.169.254/latest/meta-data/")


def test_rejects_when_dns_has_no_answer():
    r = _renderer_with_ips([])
    with pytest.raises(UrlRejectedError):
        r.validate("https://nowhere.invalid")


def test_rejects_oversized_url():
    r = _renderer_with_ips(["93.184.216.34"])
    long_url = "https://example.com/" + "a" * 5000
    with pytest.raises(UrlRejectedError):
        r.validate(long_url)


def test_rejects_missing_host():
    r = _renderer_with_ips(["93.184.216.34"])
    with pytest.raises(UrlRejectedError):
        r.validate("https:///path")


def test_accepts_public_https_ipv4():
    r = _renderer_with_ips(["93.184.216.34"])
    r.validate("https://example.com/pricing")


def test_accepts_public_https_ipv6():
    r = _renderer_with_ips(["2606:2800:220:1:248:1893:25c8:1946"])
    r.validate("https://example.com/")


# ---- connection pinning + redirect re-validation (Sev2 SSRF finding) ------


def test_rejects_ipv4_mapped_ipv6_resolution():
    r = _renderer_with_ips(["::ffff:169.254.169.254"])
    with pytest.raises(UrlRejectedError):
        r.validate("https://evil.example.com")


def test_rejects_ecs_credentials_endpoint():
    r = _renderer_with_ips(["169.254.170.2"])
    with pytest.raises(UrlRejectedError):
        r.validate("https://evil.example.com")


def test_fetch_html_rejects_redirect_to_metadata(requests_mock):
    requests_mock.get(
        "https://example.com/",
        status_code=302,
        headers={"Location": "https://169.254.169.254/latest/meta-data/"},
    )
    meta = requests_mock.get("https://169.254.169.254/latest/meta-data/", text="secret")
    with pytest.raises(UrlRejectedError):
        _renderer_with_ips(["93.184.216.34"]).fetch_html("https://example.com/")
    assert meta.call_count == 0


def test_fetch_html_connects_to_validated_ip_not_a_fresh_lookup(monkeypatch):
    """DNS rebinding: resolver flips to a private IP after validation. The
    renderer must connect to the IP it validated (via the pinned adapter),
    never re-resolving the hostname."""
    import requests

    import safe_fetch  # type: ignore[import-not-found]

    answers = iter([["93.184.216.34"], ["127.0.0.1"], ["127.0.0.1"]])
    pins = []

    class _Adapter(requests.adapters.BaseAdapter):
        def __init__(self, target, **kw):
            super().__init__()
            self.target = target

        def send(self, request, **kw):
            pins.append(self.target.ip)
            resp = requests.Response()
            resp.status_code = 200
            resp.headers["Content-Type"] = "text/html"
            resp._content = b"<html>ok</html>"
            resp._content_consumed = True
            resp.url = request.url
            return resp

        def close(self):
            pass

    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", _Adapter)
    r = UrlRenderer(dns_resolver=lambda host: next(answers))
    html, _, _ = r.fetch_html("https://rebind.example.com/")
    assert html == "<html>ok</html>"
    assert pins == ["93.184.216.34"]
