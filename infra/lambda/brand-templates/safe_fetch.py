"""
Shared SSRF-safe HTTP fetcher.

Every server-side fetch of a user- or LLM-supplied URL MUST go through
`safe_get` (or, for validation only, `validate_url`). It guarantees:

  1. Scheme allowlist (https only by default), no userinfo, length cap.
  2. The hostname is resolved ONCE per hop and every answer is checked against
     the deny policy (`is_forbidden_ip`): RFC 1918, loopback, link-local
     (incl. 169.254.169.254 IMDS and 169.254.170.2 ECS credentials), CGNAT,
     ULA, IPv6 link-local, multicast, reserved, IPv4-mapped / NAT64 / 6to4 /
     Teredo forms that embed IPv4.
  3. The TCP connection is opened against the validated IP (`PinnedIPAdapter`),
     so a DNS answer that changes between "check" and "connect" (rebinding)
     cannot steer the socket. TLS SNI, the certificate hostname check, and the
     HTTP Host header all keep using the ORIGINAL hostname, and certificate
     verification cannot be switched off.
  4. Redirects are followed manually (bounded), and each hop repeats 1-3.
  5. Proxy environment variables are ignored, body size and wall-clock
     budgets are enforced while streaming.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional, Sequence, Tuple, Union
from urllib.parse import urljoin, urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3 import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.util.retry import Retry

IPAddress = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]
Resolver = Callable[[str], List[str]]

MAX_URL_LENGTH = 2048
DEFAULT_MAX_REDIRECTS = 5
DEFAULT_CONNECT_TIMEOUT_SEC = 5.0
DEFAULT_READ_TIMEOUT_SEC = 10.0
DEFAULT_TOTAL_BUDGET_SEC = 20.0
_DEFAULT_PORTS = {"http": 80, "https": 443}


class UrlRejectedError(ValueError):
    """The URL fails the allowlist or resolves to a forbidden address."""


class UrlFetchError(RuntimeError):
    """The fetch failed: transport error, size/time cap, status, or MIME type."""


# ---- IP policy -----------------------------------------------------------

_FORBIDDEN_V4 = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",       # CGNAT
        "127.0.0.0/8",
        "169.254.0.0/16",      # link-local: IMDS 169.254.169.254, ECS 169.254.170.2
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "255.255.255.255/32",
    )
]

_FORBIDDEN_V6 = [
    ipaddress.ip_network(n)
    for n in (
        "::/128",
        "::1/128",
        "::ffff:0:0/96",       # IPv4-mapped
        "::/96",               # IPv4-compatible (deprecated)
        "64:ff9b::/96",        # NAT64
        "64:ff9b:1::/48",
        "100::/64",
        "2001:db8::/32",
        "fc00::/7",            # ULA (incl. fd00:ec2::254 IMDS)
        "fe80::/10",
        "fec0::/10",
        "ff00::/8",
    )
]


def is_forbidden_ip(ip: IPAddress) -> bool:
    """True if a connection to `ip` could reach internal or metadata services."""
    if isinstance(ip, ipaddress.IPv6Address):
        if any(ip in n for n in _FORBIDDEN_V6):
            return True
        # Addresses that tunnel an IPv4 destination: judge the embedded v4 too.
        for embedded in (ip.ipv4_mapped, ip.sixtofour, ip.teredo[1] if ip.teredo else None):
            if embedded is not None and is_forbidden_ip(embedded):
                return True
    else:
        if any(ip in n for n in _FORBIDDEN_V4):
            return True
    # Belt and braces: anything the stdlib classifies as non-global.
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or not ip.is_global
    )


def default_resolver(host: str) -> List[str]:
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        return []
    out: List[str] = []
    for info in infos:
        addr = info[4][0]
        if addr not in out:
            out.append(addr)
    return out


# ---- URL validation ------------------------------------------------------


@dataclass(frozen=True)
class PinnedTarget:
    """A validated URL plus the single IP address the connection must use."""

    url: str
    scheme: str
    hostname: str
    port: int
    ip: str

    @property
    def host_header(self) -> str:
        host = f"[{self.hostname}]" if ":" in self.hostname else self.hostname
        if self.port == _DEFAULT_PORTS.get(self.scheme):
            return host
        return f"{host}:{self.port}"


def _parse_ip(value: str) -> Optional[IPAddress]:
    try:
        return ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return None


def validate_url(
    url: str,
    *,
    resolver: Optional[Resolver] = None,
    allowed_schemes: Sequence[str] = ("https",),
) -> PinnedTarget:
    """Validate `url` and return the target pinned to a vetted IP address.

    Rejects if ANY DNS answer is forbidden (an attacker controls the order of
    answers, so "pick the first public one" is not safe).
    """
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise UrlRejectedError(f"URL must be a string up to {MAX_URL_LENGTH} characters.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as e:
        raise UrlRejectedError(f"Malformed URL: {e}") from None

    scheme = (parts.scheme or "").lower()
    if scheme not in allowed_schemes:
        raise UrlRejectedError(
            "Only " + ", ".join(f"{s}://" for s in allowed_schemes) + " URLs are allowed."
        )
    if parts.username is not None or parts.password is not None:
        raise UrlRejectedError("URLs with embedded credentials are not allowed.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise UrlRejectedError("URL must include a hostname.")
    if port is None:
        port = _DEFAULT_PORTS[scheme]

    literal = _parse_ip(host)
    if literal is not None:
        answers = [literal]
    else:
        raw = (resolver or default_resolver)(host)
        if not raw:
            raise UrlRejectedError(f"Could not resolve host: {host}")
        answers = []
        for addr in raw:
            ip = _parse_ip(addr)
            if ip is None:
                raise UrlRejectedError(f"Unresolvable address: {addr}")
            answers.append(ip)

    for ip in answers:
        if is_forbidden_ip(ip):
            raise UrlRejectedError(f"Host {host} resolves to a forbidden address range.")

    return PinnedTarget(url=url, scheme=scheme, hostname=host, port=port, ip=str(answers[0]))


# ---- Pinned transport ----------------------------------------------------


class PinnedIPAdapter(HTTPAdapter):
    """requests adapter that connects to `target.ip` while keeping TLS SNI,
    certificate hostname verification and the Host header on `target.hostname`.

    It refuses to send a request for any other scheme/host/port, so it cannot
    be mounted generically and accidentally pin the wrong destination.
    """

    def __init__(self, target: PinnedTarget, *, ca_bundle: Optional[str] = None, **kwargs):
        self._target = target
        self._ca_bundle = ca_bundle or requests.certs.where()
        super().__init__(max_retries=0, **kwargs)
        common = dict(
            host=target.ip,
            port=target.port,
            maxsize=1,
            block=False,
            retries=Retry(total=0, redirect=False, raise_on_redirect=False),
        )
        if target.scheme == "https":
            self._pool = HTTPSConnectionPool(
                server_hostname=target.hostname,   # SNI
                assert_hostname=target.hostname,   # cert must match the real name
                cert_reqs="CERT_REQUIRED",
                ca_certs=self._ca_bundle,
                **common,
            )
        else:
            self._pool = HTTPConnectionPool(**common)

    def _check(self, url: str) -> None:
        try:
            parts = urlsplit(url)
            port = parts.port or _DEFAULT_PORTS.get((parts.scheme or "").lower())
        except ValueError:
            raise UrlRejectedError("Malformed URL.") from None
        if (
            (parts.scheme or "").lower() != self._target.scheme
            or (parts.hostname or "").rstrip(".").lower() != self._target.hostname
            or port != self._target.port
        ):
            raise UrlRejectedError("Pinned adapter used for a different destination.")

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        self._check(request.url)
        return self._pool

    def get_connection(self, url, proxies=None):  # requests < 2.32.2
        self._check(url)
        return self._pool

    def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
        self._check(request.url)
        request.headers["Host"] = self._target.host_header
        # Verification is not negotiable: ignore verify=False and proxies.
        return super().send(
            request, stream=stream, timeout=timeout, verify=self._ca_bundle, cert=None, proxies={}
        )

    def close(self):
        super().close()
        self._pool.close()


# ---- High-level GET --------------------------------------------------------


@dataclass
class FetchResult:
    body: bytes
    final_url: str
    content_type: str
    status_code: int


def safe_get(
    url: str,
    *,
    allowed_mime_startswith: Iterable[str],
    max_bytes: int,
    resolver: Optional[Resolver] = None,
    allowed_schemes: Sequence[str] = ("https",),
    max_redirects: int = DEFAULT_MAX_REDIRECTS,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT_SEC,
    read_timeout: float = DEFAULT_READ_TIMEOUT_SEC,
    total_budget: float = DEFAULT_TOTAL_BUDGET_SEC,
    headers: Optional[dict] = None,
) -> FetchResult:
    """GET `url` with SSRF protections; see module docstring."""
    mimes: Tuple[str, ...] = tuple(m.lower() for m in allowed_mime_startswith)
    deadline = time.monotonic() + total_budget
    current = url

    for hop in range(max_redirects + 1):
        target = validate_url(current, resolver=resolver, allowed_schemes=allowed_schemes)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise UrlFetchError("Fetch exceeded time budget.")

        session = requests.Session()
        session.trust_env = False  # never honour HTTP(S)_PROXY / netrc
        adapter = PinnedIPAdapter(target)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        try:
            try:
                resp = session.get(
                    target.url,
                    stream=True,
                    allow_redirects=False,
                    timeout=(min(connect_timeout, remaining), min(read_timeout, remaining)),
                    headers=headers or {},
                )
            except UrlRejectedError:
                raise
            except requests.RequestException as e:
                raise UrlFetchError(f"Request failed: {type(e).__name__}") from None

            try:
                if 300 <= resp.status_code < 400:
                    loc = resp.headers.get("Location")
                    if not loc:
                        raise UrlFetchError("Redirect without Location header.")
                    if hop == max_redirects:
                        raise UrlFetchError("Exceeded redirect cap.")
                    current = urljoin(current, loc)
                    continue

                if resp.status_code >= 400:
                    raise UrlFetchError(f"HTTP {resp.status_code} for {current}")

                ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if not any(ctype.startswith(p) for p in mimes):
                    raise UrlFetchError(f"Disallowed Content-Type: {ctype!r}")

                declared = resp.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise UrlFetchError(f"Body exceeds {max_bytes} bytes.")

                body = bytearray()
                try:
                    for chunk in resp.iter_content(chunk_size=8192):
                        if chunk:
                            body.extend(chunk)
                        if len(body) > max_bytes:
                            raise UrlFetchError(f"Body exceeds {max_bytes} bytes.")
                        if time.monotonic() > deadline:
                            raise UrlFetchError("Fetch exceeded time budget.")
                except requests.RequestException as e:
                    raise UrlFetchError(f"Read failed: {type(e).__name__}") from None
                return FetchResult(
                    body=bytes(body),
                    final_url=current,
                    content_type=ctype,
                    status_code=resp.status_code,
                )
            finally:
                resp.close()
        finally:
            session.close()

    raise UrlFetchError("Exceeded redirect cap.")
