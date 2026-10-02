"""Bounded anonymous probe of the explicitly isolated v16 login edge.

GET only: never sends a password, creates a session, reads business data or
changes a service. Run mac-load while the independent CI source runs burst.
"""
import concurrent.futures
import json
import sys
import time
import urllib.error
import urllib.request

HOST = "dashboard-v16-gerencial.tazdb8.easypanel.host"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(path, headers=None):
    if path not in ("/auth/login", "/healthz", "/entry.js"):
        raise ValueError("PROBE_PATH_DENIED")
    req = urllib.request.Request("https://" + HOST + path, method="GET", headers=headers or {})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=5) as response:
            response.read(1024)
            return response.status
    except urllib.error.HTTPError as error:
        error.read(1024)
        return error.code
    except Exception:
        return "NETWORK_UNAVAILABLE"


def parallel(count, forged=False):
    if not 1 <= count <= 14:
        raise ValueError("PROBE_BUDGET_DENIED")
    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        return list(pool.map(lambda i: request("/auth/login", {
            "X-Forwarded-For": "198.51.100." + str(i + 1),
            "Forwarded": "for=198.51.100." + str(i + 1),
        } if forged else None), range(count)))


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("mac-load", "external-burst"):
        raise ValueError("PROBE_MODE_DENIED")
    mode = sys.argv[1]
    if mode == "external-burst":
        # Gives the operator time to start the bounded concurrent Mac source.
        time.sleep(45)
    result = {"source": mode, "startedAt": time.time(), "burst": parallel(14)}
    if mode == "mac-load":
        samples = []
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            samples.append({"at": time.time(), "status": request("/auth/login")})
            time.sleep(0.5)
        result["samples"] = samples
    else:
        result["forgedHeaders"] = parallel(4, forged=True)
        time.sleep(1.2)
        result["afterOneSecond"] = request("/auth/login")
        time.sleep(10.2)
        result["afterElevenSeconds"] = request("/auth/login")
    result["health"] = request("/healthz")
    result["asset"] = request("/entry.js")
    result["endedAt"] = time.time()
    # Contains timestamps and HTTP statuses only; no response body or headers.
    print(json.dumps(result), flush=True)
    assert result["burst"].count(404) >= 4, "INDEPENDENT_CLIENT_BUDGET_NOT_PROVEN"
    assert 429 in result["burst"], "EDGE_LIMIT_NOT_PROVEN"
    assert result["health"] == result["asset"] == 200, "UNRELATED_ROUTE_REGRESSION"
    if mode == "external-burst":
        assert all(status == 429 for status in result["forgedHeaders"]), "FORGED_IP_BYPASS"
        assert result["afterOneSecond"] == 429, "PERIOD_NOT_PROVEN"
        assert result["afterElevenSeconds"] == 404, "REFILL_NOT_PROVEN"


if __name__ == "__main__":
    main()
