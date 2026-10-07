"""
Tests for the shared SSRF-safe fetcher (safe_fetch.py).

Covers the Sev2 review finding "bind URL connections to validated IPs while
preserving TLS verification and checking redirects":

  * IP policy: private / loopback / link-local / metadata / CGNAT / ULA /
    IPv4-mapped IPv6 are rejected.
  * DNS rebinding: the hostname is resolved exactly once per hop and the
    socket is opened against THAT validated address, so a resolver that
    answers public-then-private cannot steer the connection.
  * Redirects: every hop is re-validated; redirects to private space,
    to a disallowed scheme, or beyond the cap are refused.
  * TLS: SNI + certificate hostname check use the ORIGINAL hostname even
    though the TCP connection goes to the pinned IP, and verification is ON
    (a cert for a different name is rejected).
"""

from __future__ import annotations

import http.server
import ipaddress
import shutil
import socket
import ssl
import subprocess
import threading
from pathlib import Path

import pytest
import requests

import safe_fetch  # type: ignore[import-not-found]
from safe_fetch import (  # type: ignore[import-not-found]
    PinnedIPAdapter,
    UrlFetchError,
    UrlRejectedError,
    is_forbidden_ip,
    safe_get,
    validate_url,
)

PUBLIC_IP = "93.184.216.34"
PUBLIC_IP_2 = "93.184.216.35"


def _resolver(ips):
    return lambda host: list(ips)


# ---- IP policy -----------------------------------------------------------


@pytest.mark.parametrize(
    "ip",
    [
        "169.254.169.254",     # EC2 IMDS
        "169.254.170.2",       # ECS task metadata / credentials endpoint
        "169.254.0.1",
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.0.1",
        "127.0.0.1",
        "127.1.2.3",
        "100.64.0.1",          # CGNAT
        "100.127.255.255",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fc00::1",
        "fd00:ec2::254",       # IMDS over IPv6
        "fe80::1",
        "::ffff:127.0.0.1",    # IPv4-mapped loopback
        "::ffff:169.254.169.254",
        "::ffff:10.0.0.1",
        "::ffff:8.8.8.8",      # any IPv4-mapped form is refused outright
        "64:ff9b::a9fe:a9fe",  # NAT64 of 169.254.169.254
        "2002:a9fe:a9fe::1",   # 6to4 wrapping 169.254.169.254
    ],
)
def test_forbidden_ips(ip):
    assert is_forbidden_ip(ipaddress.ip_address(ip)) is True


@pytest.mark.parametrize(
    "ip",
    ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"],
)
def test_public_ips_allowed(ip):
    assert is_forbidden_ip(ipaddress.ip_address(ip)) is False


def test_validate_rejects_private_resolution():
    with pytest.raises(UrlRejectedError):
        validate_url("https://evil.example.com/", resolver=_resolver(["10.1.2.3"]))


def test_validate_rejects_if_any_answer_is_private():
    with pytest.raises(UrlRejectedError):
        validate_url(
            "https://evil.example.com/",
            resolver=_resolver([PUBLIC_IP, "169.254.169.254"]),
        )


def test_validate_rejects_ipv4_mapped_ipv6_literal():
    with pytest.raises(UrlRejectedError):
        validate_url("https://[::ffff:169.254.169.254]/", resolver=_resolver([]))


def test_validate_rejects_private_ip_literal_without_dns():
    calls = []

    def resolver(host):
        calls.append(host)
        return [PUBLIC_IP]

    with pytest.raises(UrlRejectedError):
        validate_url("https://127.0.0.1/", resolver=resolver)
    assert calls == []  # literals are never sent to DNS


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/",
        "ftp://example.com/",
        "file:///etc/passwd",
        "gopher://example.com/",
        "https://user:pass@example.com/",
        "https:///nohost",
    ],
)
def test_validate_rejects_bad_urls(url):
    with pytest.raises(UrlRejectedError):
        validate_url(url, resolver=_resolver([PUBLIC_IP]))


def test_validate_allows_http_when_explicitly_permitted():
    target = validate_url(
        "http://example.com/", resolver=_resolver([PUBLIC_IP]), allowed_schemes=("http", "https")
    )
    assert target.scheme == "http"
    assert target.port == 80


def test_validate_returns_pinned_target():
    target = validate_url("https://Example.com:8443/x?y=1", resolver=_resolver([PUBLIC_IP]))
    assert target.hostname == "example.com"
    assert target.port == 8443
    assert target.ip == PUBLIC_IP
    assert target.host_header == "example.com:8443"


# ---- DNS rebinding -------------------------------------------------------


class _RecordingAdapterFactory:
    """Stands in for PinnedIPAdapter so we can see which IP each hop pins to."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.pins = []

    def __call__(self, target, **kwargs):
        factory = self

        class _Adapter(requests.adapters.BaseAdapter):
            def send(self, request, **kw):
                factory.pins.append((target.hostname, target.ip, request.url))
                status, headers, body = factory.responses.pop(0)
                resp = requests.Response()
                resp.status_code = status
                resp.headers.update(headers)
                resp.raw = _Raw(body)
                resp.url = request.url
                resp.request = request
                return resp

            def close(self):
                pass

        return _Adapter()


class _Raw:
    def __init__(self, body: bytes):
        self._body = body
        self._done = False

    def read(self, amt=None, decode_content=None):
        if self._done:
            return b""
        self._done = True
        return self._body

    def stream(self, amt=8192, decode_content=None):
        yield self._body

    def close(self):
        pass

    def release_conn(self):
        pass


def test_rebinding_resolver_cannot_redirect_connection(monkeypatch):
    """Resolver answers public first, private second: the connection is pinned
    to the first (validated) answer and DNS is not consulted again for that hop."""
    answers = [[PUBLIC_IP], ["169.254.169.254"]]
    calls = []

    def rebinding_resolver(host):
        calls.append(host)
        return answers[min(len(calls) - 1, 1)]

    factory = _RecordingAdapterFactory([(200, {"Content-Type": "text/html"}, b"ok")])
    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", factory)

    # Any library-level DNS lookup during the fetch would be a TOCTOU hole.
    def no_dns(*a, **k):
        raise AssertionError("unexpected DNS lookup during pinned fetch")

    monkeypatch.setattr(socket, "getaddrinfo", no_dns)

    result = safe_get(
        "https://rebind.example.com/",
        resolver=rebinding_resolver,
        allowed_mime_startswith=("text/html",),
        max_bytes=1024,
    )
    assert result.body == b"ok"
    assert calls == ["rebind.example.com"]
    assert factory.pins == [("rebind.example.com", PUBLIC_IP, "https://rebind.example.com/")]


def test_rebinding_on_second_hop_is_caught(monkeypatch):
    """Each redirect hop re-resolves AND re-validates — a rebinding answer on
    hop 2 is rejected before any connection is made."""
    answers = iter([[PUBLIC_IP], ["10.0.0.7"]])
    factory = _RecordingAdapterFactory(
        [(302, {"Location": "https://rebind.example.com/next"}, b"")]
    )
    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", factory)
    with pytest.raises(UrlRejectedError):
        safe_get(
            "https://rebind.example.com/",
            resolver=lambda host: next(answers),
            allowed_mime_startswith=("text/html",),
            max_bytes=1024,
        )
    assert len(factory.pins) == 1  # never connected for hop 2


# ---- redirects -----------------------------------------------------------


def test_redirect_to_private_ip_literal_rejected(monkeypatch):
    factory = _RecordingAdapterFactory(
        [(301, {"Location": "https://169.254.169.254/latest/meta-data/"}, b"")]
    )
    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", factory)
    with pytest.raises(UrlRejectedError):
        safe_get(
            "https://example.com/",
            resolver=_resolver([PUBLIC_IP]),
            allowed_mime_startswith=("text/html",),
            max_bytes=1024,
        )
    assert len(factory.pins) == 1


def test_redirect_to_host_resolving_private_rejected(monkeypatch):
    def resolver(host):
        return ["192.168.1.10"] if host == "internal.example.com" else [PUBLIC_IP]

    factory = _RecordingAdapterFactory(
        [(307, {"Location": "https://internal.example.com/admin"}, b"")]
    )
    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", factory)
    with pytest.raises(UrlRejectedError):
        safe_get(
            "https://example.com/",
            resolver=resolver,
            allowed_mime_startswith=("text/html",),
            max_bytes=1024,
        )


def test_redirect_scheme_downgrade_rejected(monkeypatch):
    factory = _RecordingAdapterFactory([(302, {"Location": "http://example.com/"}, b"")])
    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", factory)
    with pytest.raises(UrlRejectedError):
        safe_get(
            "https://example.com/",
            resolver=_resolver([PUBLIC_IP]),
            allowed_mime_startswith=("text/html",),
            max_bytes=1024,
        )


def test_redirect_cap_enforced(monkeypatch):
    factory = _RecordingAdapterFactory(
        [(302, {"Location": f"/r{i}"}, b"") for i in range(10)]
    )
    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", factory)
    with pytest.raises(UrlFetchError):
        safe_get(
            "https://example.com/",
            resolver=_resolver([PUBLIC_IP]),
            allowed_mime_startswith=("text/html",),
            max_bytes=1024,
            max_redirects=5,
        )
    assert len(factory.pins) == 6  # initial + 5 redirects, then refuse


def test_redirect_followed_and_repinned(monkeypatch):
    def resolver(host):
        return [PUBLIC_IP_2] if host == "cdn.example.net" else [PUBLIC_IP]

    factory = _RecordingAdapterFactory(
        [
            (301, {"Location": "https://cdn.example.net/page"}, b""),
            (200, {"Content-Type": "text/html; charset=utf-8"}, b"<html>hi</html>"),
        ]
    )
    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", factory)
    result = safe_get(
        "https://example.com/",
        resolver=resolver,
        allowed_mime_startswith=("text/html",),
        max_bytes=1024,
    )
    assert result.final_url == "https://cdn.example.net/page"
    assert [p[1] for p in factory.pins] == [PUBLIC_IP, PUBLIC_IP_2]


def test_body_size_cap(monkeypatch):
    factory = _RecordingAdapterFactory([(200, {"Content-Type": "text/html"}, b"x" * 2048)])
    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", factory)
    with pytest.raises(UrlFetchError):
        safe_get(
            "https://example.com/",
            resolver=_resolver([PUBLIC_IP]),
            allowed_mime_startswith=("text/html",),
            max_bytes=1024,
        )


def test_transport_errors_become_fetch_errors(monkeypatch):
    class _Boom(requests.adapters.BaseAdapter):
        def send(self, request, **kw):
            raise requests.ConnectionError("refused")

        def close(self):
            pass

    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", lambda target, **kw: _Boom())
    with pytest.raises(UrlFetchError):
        safe_get(
            "https://example.com/",
            resolver=_resolver([PUBLIC_IP]),
            allowed_mime_startswith=("text/html",),
            max_bytes=1024,
        )


def test_session_ignores_proxy_environment(monkeypatch):
    """HTTPS_PROXY in the environment must not route the pinned request elsewhere."""
    monkeypatch.setenv("HTTPS_PROXY", "http://10.0.0.1:3128")
    seen = {}

    class _Probe(requests.adapters.BaseAdapter):
        def send(self, request, **kw):
            seen["proxies"] = kw.get("proxies")
            raise requests.ConnectionError("stop")

        def close(self):
            pass

    monkeypatch.setattr(safe_fetch, "PinnedIPAdapter", lambda target, **kw: _Probe())
    with pytest.raises(UrlFetchError):
        safe_get(
            "https://example.com/",
            resolver=_resolver([PUBLIC_IP]),
            allowed_mime_startswith=("text/html",),
            max_bytes=1024,
        )
    assert not seen["proxies"]


# ---- PinnedIPAdapter against a real local TLS server ----------------------


@pytest.fixture(scope="module")
def tls_server(tmp_path_factory):
    """HTTPS server on 127.0.0.1 presenting a self-signed cert for
    pinned.example.test. Records the SNI and Host header it receives."""
    if shutil.which("openssl") is None:
        pytest.skip("openssl not available")
    d: Path = tmp_path_factory.mktemp("tls")
    cert, key = d / "cert.pem", d / "key.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "1",
            "-subj", "/CN=pinned.example.test",
            "-addext", "subjectAltName=DNS:pinned.example.test",
        ],
        check=True,
        capture_output=True,
    )
    seen = {"sni": [], "host": []}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen["host"].append(self.headers.get("Host"))
            body = b"<html>pinned</html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert), str(key))
    ctx.sni_callback = lambda sock, name, c: seen["sni"].append(name)

    httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield {"port": httpd.server_address[1], "cert": str(cert), "seen": seen}
    httpd.shutdown()


def _pinned_session(target, ca):
    s = requests.Session()
    s.trust_env = False
    adapter = PinnedIPAdapter(target, ca_bundle=ca)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def test_pinned_adapter_preserves_sni_and_host(tls_server, monkeypatch):
    port = tls_server["port"]
    # pinned.example.test does not resolve; any DNS attempt would fail the test.
    real_getaddrinfo = socket.getaddrinfo

    def guarded(host, *a, **k):
        assert host in ("127.0.0.1",), f"unexpected DNS lookup for {host!r}"
        return real_getaddrinfo(host, *a, **k)

    monkeypatch.setattr(socket, "getaddrinfo", guarded)

    target = safe_fetch.PinnedTarget(
        url=f"https://pinned.example.test:{port}/",
        scheme="https",
        hostname="pinned.example.test",
        port=port,
        ip="127.0.0.1",
    )
    s = _pinned_session(target, tls_server["cert"])
    r = s.get(target.url, timeout=5)
    assert r.status_code == 200
    assert r.text == "<html>pinned</html>"
    assert tls_server["seen"]["sni"][-1] == "pinned.example.test"
    assert tls_server["seen"]["host"][-1] == f"pinned.example.test:{port}"


def test_pinned_adapter_keeps_tls_verification_on(tls_server):
    """Same pinned IP, but the URL names a host the cert does not cover:
    verification must fail (it would silently succeed if verify were off)."""
    port = tls_server["port"]
    target = safe_fetch.PinnedTarget(
        url=f"https://other.example.test:{port}/",
        scheme="https",
        hostname="other.example.test",
        port=port,
        ip="127.0.0.1",
    )
    s = _pinned_session(target, tls_server["cert"])
    with pytest.raises(requests.exceptions.SSLError):
        s.get(target.url, timeout=5)


def test_pinned_adapter_ignores_verify_false(tls_server):
    """A caller passing verify=False must not be able to switch TLS checks off."""
    port = tls_server["port"]
    target = safe_fetch.PinnedTarget(
        url=f"https://other.example.test:{port}/",
        scheme="https",
        hostname="other.example.test",
        port=port,
        ip="127.0.0.1",
    )
    s = _pinned_session(target, tls_server["cert"])
    with pytest.raises(requests.exceptions.SSLError):
        s.get(target.url, timeout=5, verify=False)


def test_pinned_adapter_refuses_other_hosts(tls_server):
    """An adapter pinned for host A must not be reused to send a request for host B."""
    port = tls_server["port"]
    target = safe_fetch.PinnedTarget(
        url=f"https://pinned.example.test:{port}/",
        scheme="https",
        hostname="pinned.example.test",
        port=port,
        ip="127.0.0.1",
    )
    s = _pinned_session(target, tls_server["cert"])
    with pytest.raises(UrlRejectedError):
        s.get(f"https://elsewhere.example.test:{port}/", timeout=5)
