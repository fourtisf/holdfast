#!/usr/bin/env python3
"""Domain availability for name candidates.

DNS first (an NS answer means registered), then RDAP for the names DNS doesn't know (404 = not registered).
Runs in GitHub Actions (.github/workflows/domain-check.yml), where the internet is open.

    python3 check.py names.txt [tld ...]
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

TLDS = sys.argv[2:] or ["fun", "xyz", "so", "meme", "com", "io", "app", "gg"]


def dns_status(domain):
    out = subprocess.run(["dig", "+time=3", "+tries=2", "NS", domain], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "status:" in line:
            return line.split("status:")[1].split(",")[0].strip()
    return "ERROR"


def rdap_servers():
    with urllib.request.urlopen("https://data.iana.org/rdap/dns.json", timeout=20) as r:
        data = json.load(r)
    return {tld: urls[0].rstrip("/") + "/" for tlds, urls in data["services"] for tld in tlds}


def rdap(domain, servers):
    base = servers.get(domain.rsplit(".", 1)[1])
    if not base:
        return "no-rdap"
    req = urllib.request.Request(base + "domain/" + domain, headers={"accept": "application/rdap+json", "user-agent": "holdfast-domain-check"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=15):
                return "registered"
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return "free"
            if e.code == 429:
                time.sleep(3 + 4 * attempt)
                continue
            return f"http-{e.code}"
        except Exception:
            return "error"
    return "rate-limited"


def main():
    names = [l.strip().lower() for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")]
    servers = rdap_servers()
    available, probable = {}, {}
    print(f"{len(names)} names x {len(TLDS)} TLDs: {', '.join(TLDS)}\n")
    for name in names:
        row = []
        for tld in TLDS:
            domain = f"{name}.{tld}"
            status = dns_status(domain)
            if status == "NXDOMAIN":
                r = rdap(domain, servers)
                time.sleep(0.25)
                if r == "free":
                    verdict = "AVAILABLE"
                    available.setdefault(name, []).append(tld)
                elif r == "registered":
                    verdict = "taken"
                else:
                    verdict = f"likely-free({r})"
                    probable.setdefault(name, []).append(tld)
            elif status == "NOERROR":
                verdict = "taken"
            else:
                verdict = f"dns-{status}"
            row.append(f"{tld}:{verdict}")
        print(f"{name:14s} " + "  ".join(row), flush=True)

    lines = ["", "=== AVAILABLE (RDAP confirms not registered) ==="]
    lines += [f"{n}: {', '.join('.' + t for t in ts)}" for n, ts in available.items()] or ["(none)"]
    lines += ["", "=== LIKELY FREE (no DNS, registry has no RDAP answer) ==="]
    lines += [f"{n}: {', '.join('.' + t for t in ts)}" for n, ts in probable.items()] or ["(none)"]
    print("\n".join(lines))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("```\n" + "\n".join(lines) + "\n```\n")


if __name__ == "__main__":
    main()
