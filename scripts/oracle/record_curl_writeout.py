#!/usr/bin/env python3
"""Record the real curl 8.5.0 printing --write-out and its request lines against a scripted HTTP server.

usage: record_curl_writeout.py out.json

A throw-away HTTP/1.1 server on 127.0.0.1 answers a few paths with fixed raw bytes (kept in the fixture, so the simulator serves the very same
bytes); every case runs the installed curl and keeps stdout, stderr and the exit status; the '>' lines of curl -v give the request it sent.
Values that differ from run to run (ports, timings) are compared by shape by the replay test.
"""
import json, os, socket, subprocess, sys, threading, tempfile

RESPONSES = {
    "/ok": b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nX-Test: abc\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nConnection: close\r\n\r\nhello\n",
    "/redir": b"HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    "/missing": b"HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found",
    "/empty": b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n",
}

FORMATS = [
    "%{http_code}", "%{http_code}\\n", "%{response_code}", "%{content_type}", "%{size_download}", "%{size_header}", "%{size_request}",
    "%{size_upload}", "%{num_headers}", "%{num_connects}", "%{num_redirects}", "%{scheme}", "%{method}", "%{http_version}", "%{url}",
    "%{urlnum}", "%{url_effective}", "%{filename_effective}", "%{redirect_url}", "%{referer}", "%{exitcode}", "%{errormsg}",
    "%{ssl_verify_result}", "%{http_connect}", "%{remote_ip}",
    "%{url.scheme}|%{url.host}|%{url.port}|%{url.path}|%{url.query}|%{url.fragment}|%{url.user}",
    "%{urle.scheme}|%{urle.host}|%{urle.port}|%{urle.path}|%{urle.query}",
    "%header{x-test}|%header{content-type}|%header{nope}|%header{set-cookie}|%header{X-TEST}",
    "%{header_json}", "%{onerror}after", "%{stderr}to-stderr\\n%{stdout}to-stdout", "%output{OUTFILE}into-file%{stdout}|after",
    "a\\tb\\r|\\\\|\\q|%%|%z|%|%{|%{unknown}|%{HTTP_CODE}|\\",
    "%{time_namelookup}", "%{time_connect}", "%{time_appconnect}", "%{time_pretransfer}", "%{time_starttransfer}", "%{time_redirect}",
    "%{time_total}", "%{speed_download}", "%{speed_upload}",
    "%{http_code} %{size_download} %{content_type}\\n",
]

W = "%{http_code}"
CASES = [(f, "/ok", []) for f in FORMATS] + [
    ("%{http_code} %{num_redirects} %{url_effective} %{redirect_url} %{size_header} %{size_request} %{num_connects}", "/redir", ["-L"]),
    ("%{http_code} %{num_redirects} %{url_effective} %{redirect_url} %{size_header} %{size_request}", "/redir", []),
    ("%{http_code} %{size_download} %{content_type}|", "/missing", []),
    ("%{http_code} %{size_download} %{num_headers} %{size_header}", "/empty", []),
    ("%{http_code} %{method} %{size_upload} %{size_request}", "/ok", ["-X", "POST", "-d", "a=1&b=2"]),
    ("%{http_code} %{method} %{size_download} %{size_header}", "/ok", ["-I"]),
    ("%{http_code} %{size_download} %{filename_effective}", "/ok", ["-O"]),
    ("%{http_code} %{exitcode} %{errormsg}|", "/ok", ["--fail", "--max-redirs", "0"]),
    ("%{http_code} %{exitcode}|%{errormsg}|", "/missing", ["--fail"]),
    ("%{onerror}%{http_code} %{exitcode} %{errormsg}\\n", "/missing", ["--fail"]),
    ("%{http_code} %{referer}", "/ok", ["-e", "http://example.org/"]),
    ("%{url} %{urlnum} %{http_code}\\n", "/ok", ["URL2"]),
    ("%{json}", "/ok", []),
]

VERBOSE_CASES = [
    ("get", "/ok", []), ("head", "/ok", ["-I"]), ("post", "/ok", ["-X", "POST", "-d", "a=1&b=2"]),
    ("header", "/ok", ["-H", "X-A: 1", "-H", "Accept: text/plain"]), ("auth", "/ok", ["-u", "bob:secret"]),
    ("referer-agent", "/ok", ["-e", "http://example.org/", "-A", "probe/1"]), ("follow", "/redir", ["-L"]),
]

FAILURES = [
    "%{http_code} %{exitcode} %{errormsg}|%{remote_ip}|%{remote_port}|%{local_ip}|%{local_port}|%{scheme}|%{method}|%{http_version}|"
    "%{content_type}|%{size_request}|%{size_header}|%{num_connects}|%{url_effective}|%{ssl_verify_result}",
]

def serve(listener):
    while True:
        try:
            connection, _ = listener.accept()
        except OSError:
            return
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = connection.recv(65536)
            if not chunk:
                break
            data += chunk
        first = data.split(b"\r\n", 1)[0].decode("latin1").split(" ")
        path = first[1].split("?")[0] if len(first) > 1 else "/"
        connection.sendall(RESPONSES.get(path, RESPONSES["/missing"]))
        connection.close()

def main():
    target = sys.argv[1]
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    port = listener.getsockname()[1]
    threading.Thread(target=serve, args=(listener,), daemon=True).start()
    work = tempfile.mkdtemp()
    fixture = {"curl": "8.5.0", "port": port, "responses": {k: list(v) for k, v in RESPONSES.items()}, "cases": [], "verbose": [], "failures": []}
    for fmt, path, flags in CASES:
        outfile = os.path.join(work, "out.txt")
        arguments = ["-s", "-o", "/dev/null"] + [a for a in flags if a != "URL2"] + ["-w", fmt.replace("OUTFILE", outfile)]
        urls = [f"http://127.0.0.1:{port}{path}"]
        if "URL2" in flags:
            urls.append(f"http://127.0.0.1:{port}/missing")
        if "-O" in flags:
            arguments = [a for a in arguments if a not in ("-o", "/dev/null")]
        run = subprocess.run(["curl"] + arguments + urls, capture_output=True, text=True, cwd=work)
        written = open(outfile).read() if os.path.exists(outfile) else None
        fixture["cases"].append({
            "format": fmt, "path": path, "flags": flags, "stdout": run.stdout, "stderr": run.stderr, "exit": run.returncode, "file": written,
        })
        if os.path.exists(outfile):
            os.remove(outfile)
    for name, path, flags in VERBOSE_CASES:
        run = subprocess.run(["curl", "-sv", "-o", "/dev/null"] + flags + [f"http://127.0.0.1:{port}{path}"], capture_output=True, text=True, cwd=work)
        lines = [l for l in run.stderr.split("\n") if l.startswith("> ")]
        fixture["verbose"].append({"name": name, "path": path, "flags": flags, "lines": lines, "exit": run.returncode})
    for fmt in FAILURES:
        for label, url in (("refused", None), ("unresolvable", "http://no-such-host.invalid/")):
            if url is None:
                closed = socket.socket()
                closed.bind(("127.0.0.1", 0))
                dead = closed.getsockname()[1]
                closed.close()
                url = f"http://127.0.0.1:{dead}/"
            run = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", fmt, url], capture_output=True, text=True, timeout=60)
            fixture["failures"].append({"label": label, "format": fmt, "url": url, "stdout": run.stdout, "stderr": run.stderr, "exit": run.returncode})
    json.dump(fixture, open(target, "w"), indent=1)

if __name__ == "__main__":
    main()
