"""Smoke-test a built Grafana image against the SQLite locking regression."""
import concurrent.futures
import subprocess
import sys
import time
import uuid

name = "grafana-wal-test-" + uuid.uuid4().hex[:8]
image = sys.argv[1]


def docker(*args):
    return subprocess.run(["docker", *args], capture_output=True, text=True)


try:
    result = docker(
        "run", "-d", "--name", name, "--network", "none",
        "--tmpfs", "/var/lib/grafana:uid=472,gid=0",
        "-e", "LOKI_INTERNAL_URL=http://127.0.0.1:3100",
        "-e", "PROMETHEUS_INTERNAL_URL=http://127.0.0.1:9090",
        "-e", "TEMPO_INTERNAL_URL=http://127.0.0.1:3200", image,
    )
    assert result.returncode == 0, result.stderr
    for _ in range(30):
        if docker("exec", name, "wget", "-qO-", "http://127.0.0.1:3000/api/health").returncode == 0:
            break
        time.sleep(1)
    else:
        raise AssertionError("Grafana did not become healthy")

    # SQLite's file header is independent of the image's installed SQL tools.
    result = docker("exec", name, "od", "-An", "-tu1", "-j", "18", "-N", "2", "/var/lib/grafana/grafana.db")
    assert result.returncode == 0 and result.stdout.split() == ["2", "2"], "SQLite WAL is disabled"

    def request(_):
        return docker("exec", name, "wget", "-qO-", "http://admin:admin@127.0.0.1:3000/api/datasources").returncode

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        assert all(code == 0 for code in pool.map(request, range(20))), "Datasource request failed"
    print("PASS: SQLite WAL enabled and 20 concurrent datasource requests succeeded")
finally:
    docker("rm", "-f", name)
