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
