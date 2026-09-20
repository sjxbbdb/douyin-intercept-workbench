"""Strict, non-credential URL validation for the sidecar boundary."""
from urllib.parse import urlsplit, urlunsplit


ALLOWED_HOSTS = {
    "www.douyin.com",
    "live.douyin.com",
    "v.douyin.com",
}


class URLPolicyError(ValueError):
    pass


def safe_url(value, purpose="url", allow_root=False, keep_query=False):
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise URLPolicyError("%s must be a URL" % purpose)
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() != "https" or parsed.username or parsed.password:
        raise URLPolicyError("%s must use https without credentials" % purpose)
    host = (parsed.hostname or "").lower().rstrip(".")
    if host not in ALLOWED_HOSTS:
        raise URLPolicyError("%s host is not allowed" % purpose)
    if (not parsed.path or parsed.path == "/") and not allow_root:
        raise URLPolicyError("%s path is required" % purpose)
    # Do not echo query strings: they may contain opaque platform parameters.
    return urlunsplit(("https", host, parsed.path or "/", parsed.query if keep_query else "", ""))


def redact_url(value):
    try:
        parsed = urlsplit(str(value))
        if parsed.scheme and parsed.netloc:
            return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except Exception:
        pass
    return "<redacted-url>"
