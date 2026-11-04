#!/usr/bin/env python3
"""Record what the real hostnamectl 255.4 prints and what the real systemd-hostnamed writes, logs and refuses.

usage: record_hostnamectl.py out.json

Each scenario runs in its own UTS, mount and PID namespace (unshare -u -m -p -f --mount-proc, needs root): /etc is an overlay (hostnamed replaces /etc/hostname and /etc/machine-info by renaming a
file over them, which a bind mount refuses), /etc/os-release and the DMI directory /sys/class/dmi/id are the scenario's, and a private D-Bus daemon carries four services: the real
systemd-hostnamed (its log, which goes to the journal on a real machine, is read from its standard error), the real polkitd (the answer a non-root caller gets), a stand-in for the systemd manager
(fake_systemd1.py: hostnamectl status reads Virtualization and Architecture from it) and nothing else. A run is (argv, uid) -> (stdout, stderr, status) followed by a snapshot of /etc/hostname,
/etc/machine-info, the kernel host name and the lines hostnamed logged during the run. Needs root, dbus-daemon, polkitd and systemd 255 (/usr/lib/systemd/systemd-hostnamed); runs are replayed in order.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
BUS_DIR = "/tmp/hnctl-bus"
NOBODY = 65534

OS_RELEASE = (
    'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.5 LTS (Noble Numbat)"\nVERSION_CODENAME=noble\nID=ubuntu\nID_LIKE=debian\n'
    'HOME_URL="https://www.ubuntu.com/"\nSUPPORT_URL="https://help.ubuntu.com/"\nBUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"\nUBUNTU_CODENAME=noble\n'
)

GETTERS = [
    [], ["status"], ["hostname"], ["--static"], ["--transient"], ["--pretty"], ["--static", "hostname"], ["--pretty", "hostname"], ["--transient", "hostname"], ["icon-name"], ["chassis"],
    ["deployment"], ["location"], ["--json=pretty"], ["--json=short"], ["--json=off"], ["--static", "--pretty"], ["--static", "--transient"], ["--transient", "--pretty", "--static"],
]
CLI_ERRORS = [
    ["--version"], ["--help"], ["-h"], ["help"], ["status", "extra"], ["bogus"], ["--bogus"], ["-x"], ["--json=bogus"], ["--json"], ["-H"], ["hostname", "a", "b"], ["icon-name", "a", "b"],
    ["set-hostname"], ["set-hostname", "a", "b"], ["set-icon-name"], ["--no-ask-password", "status"], ["--static", "status"],
    ["stat"], ["statu"], ["hostnam"], ["chass"], ["locat"], ["icon"], ["xyz"], ["set"], ["set-hostnam"], ["Status"], ["deploy"], ["--version", "status"], ["--help", "bogus"],
    ["--json=help"], ["--json="], ["--json=pretty", "status"], ["--json=short", "--static"], ["-H"], ["--host"], ["-h", "-x"], ["-x", "-h"], ["--version", "-x"],
    ["-M"], ["-M", "nosuchcontainer", "status"], ["--machine=nosuchcontainer"], ["--host=nosuchhost", "status"], ["--host=nosuchhost", "hostname"], ["--host=nosuchhost", "hostname", "x"], ["--host=nosuchhost", "chassis"], ["--host=nosuchhost", "chassis", "vm"],
    ["--host=nosuchhost", "--json=short"], ["--host=nosuchhost", "--static"], ["--host=nosuchhost", "--transient", "hostname", "x"], ["--host=nosuchhost", "--static", "hostname", "x"],
    ["--host=nosuchhost", "bogus"], ["--host=nosuchhost", "set-hostname"],
]
SETS = [
    ["hostname", "newname"], ["hostname", "new-name.example.com"], ["set-hostname", "obsolete.example"], ["hostname", "UPPER.Example"], ["hostname", "trailing.dot."], ["hostname", "under_score"],
    ["hostname", "-lead"], ["hostname", "lead-"], ["hostname", "a..b"], ["hostname", ".lead"], ["hostname", "has space"], ["hostname", "Pretty Name 1!"], ["hostname", "a" * 64],
    ["hostname", "a" * 65], ["hostname", "é.example"], ["hostname", ""], ["--static", "hostname", "static-only"], ["--transient", "hostname", "transient-only"], ["--pretty", "hostname", "Pretty: Only"],
    ["--static", "--transient", "hostname", "st-tr"], ["--pretty", "--static", "hostname", "pr-st"], ["--pretty", "--transient", "hostname", "pr-tr"], ["--static", "hostname", ""],
    ["--transient", "hostname", ""], ["--pretty", "hostname", ""], ["--static", "hostname", "bad_static"], ["--transient", "hostname", "bad_transient"], ["--pretty", "hostname", "tab\tinside"],
    ["icon-name", "computer-laptop"], ["icon-name", "bad/icon"], ["icon-name", "."], ["icon-name", ""], ["chassis", "laptop"], ["chassis", "server"], ["chassis", "vm"], ["chassis", "container"],
    ["chassis", "desktop"], ["chassis", "convertible"], ["chassis", "tablet"], ["chassis", "handset"], ["chassis", "watch"], ["chassis", "embedded"], ["chassis", "bogus"], ["chassis", "Server"],
    ["chassis", ""], ["deployment", "production"], ["deployment", "Staging-1"], ["deployment", "bad deployment"], ["deployment", "a.b_c"], ["deployment", ""], ["location", "Paris DC1, rack 4"],
    ["location", "bad\nlocation"], ["location", ""], ["deployment", "a.b"], ["deployment", "a:b"], ["deployment", "a_b"], ["deployment", "a-b"], ["deployment", "é"], ["deployment", ""], ["set-icon-name", "computer-desktop"], ["set-chassis", "laptop"], ["set-deployment", "dev"], ["set-location", "lab"],
    ["--static", "icon-name", "x"], ["--transient", "chassis", "vm"], ["hostname", "newname"], ["hostname", "newname"],
]


def scenario_list():
    scenarios = [
        {
            "name": "static-and-no-machine-info", "etc_hostname": "box.example\n", "machine_info": None, "kernel": "box.example", "virt": "docker", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in GETTERS + CLI_ERRORS],
        },
        {
            "name": "machine-info-preset", "etc_hostname": "core\n", "kernel": "core",
            "machine_info": 'PRETTY_HOSTNAME="Bank Core Router"\nICON_NAME=computer-server\nCHASSIS=server\nDEPLOYMENT=production\nLOCATION="Paris DC1"\n',
            "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in GETTERS],
        },
        {
            "name": "transient-only", "etc_hostname": None, "machine_info": None, "kernel": "transient.example", "virt": "docker", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in GETTERS] + [(["--transient", "hostname", "second.example"], 0), (["status"], 0), (["--static", "hostname", "now-static"], 0), (["status"], 0),
                                                  (["--transient", "hostname", "third.example"], 0), (["status"], 0)],
        },
        {
            "name": "transient-differs", "etc_hostname": "static.example\n", "machine_info": None, "kernel": "other.example", "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in GETTERS],
        },
        {
            "name": "writes", "etc_hostname": "start.example\n", "machine_info": None, "kernel": "start.example", "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in SETS] + [(["status"], 0), (["--json=short"], 0)],
        },
        {
            "name": "machine-info-foreign", "etc_hostname": "keep.example\n", "kernel": "keep.example",
            "machine_info": '# a comment\nFOO=bar\nPRETTY_HOSTNAME=Old Pretty\nHARDWARE_VENDOR="Some Vendor"\nCHASSIS=laptop\n\nLOCATION=\'single quoted\'\n',
            "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in [["status"], ["--json=short"], ["chassis", "server"], ["--pretty", "hostname", "New Pretty"], ["deployment", "dev"], ["location", ""], ["chassis", ""],
                                        ["--pretty", "hostname", ""], ["status"]]],
        },
        {
            "name": "etc-hostname-contents", "etc_hostname": "  spaced.example  \n", "machine_info": None, "kernel": "kernelname", "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in [["--static"], ["--json=short"], ["status"]]],
        },
        {
            "name": "etc-hostname-comment", "etc_hostname": "# the name\nreal.example\n", "machine_info": None, "kernel": "kernelname", "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in [["--static"], ["--json=short"], ["status"]]],
        },
        {
            "name": "etc-hostname-invalid", "etc_hostname": "bad_name\n", "machine_info": None, "kernel": "kernelname", "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in [["--static"], ["--json=short"], ["status"], ["hostname", "fixed"], ["status"]]],
        },
        {
            "name": "etc-hostname-empty", "etc_hostname": "\n", "machine_info": None, "kernel": "kernelname", "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in [["--static"], ["--json=short"], ["status"]]],
        },
        {
            "name": "etc-hostname-long-line", "etc_hostname": "first.example\nsecond.example\n", "machine_info": None, "kernel": "kernelname", "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, 0) for a in [["--static"], ["--json=short"]]],
        },
        {
            "name": "os-release-fields", "etc_hostname": "os.example\n", "machine_info": None, "kernel": "os.example", "virt": "vm-other", "arch": "x86", "dmi": None,
            "os_release": OS_RELEASE + 'CPE_NAME="cpe:/o:canonical:ubuntu_linux:24.04"\nDEFAULT_HOSTNAME=defaulthost\n',
            "runs": [(a, 0) for a in [[], ["status"], ["--json=short"]]],
        },
        {
            "name": "default-hostname", "etc_hostname": None, "machine_info": None, "kernel": "(none)", "virt": "kvm", "arch": "x86-64", "dmi": None,
            "os_release": OS_RELEASE + "DEFAULT_HOSTNAME=defaulthost\n",
            "runs": [(a, 0) for a in [[], ["hostname"], ["--static"], ["--transient"], ["--json=short"]]] + [(["--static", "hostname", ""], 0), (["status"], 0)],
        },
        {
            "name": "non-root", "etc_hostname": "box.example\n", "machine_info": None, "kernel": "box.example", "virt": "kvm", "arch": "x86-64", "dmi": None, "os_release": OS_RELEASE,
            "runs": [(a, NOBODY) for a in [[], ["hostname"], ["--json=short"], ["hostname", "newname"], ["--static", "hostname", "newname"], ["--transient", "hostname", "newname"],
                                           ["--pretty", "hostname", "New Name"], ["--no-ask-password", "hostname", "newname"], ["icon-name", "computer-laptop"], ["chassis", "laptop"],
                                           ["deployment", "dev"], ["location", "lab"], ["hostname", "under_score"], ["chassis", "bogus"], ["hostname", ""], ["hostname", "box.example"],
                                           ["--static", "hostname", "box.example"], ["icon-name", ""], ["--transient", "hostname", "bad_name"], ["status"]]],
        },
    ]
    for scenario in scenarios:
        if scenario["name"] not in ("machine-info-preset", "writes"):
            scenario["virt"] = "docker"
    return scenarios


def read_text(path):
    try:
        with open(path) as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def run_child(spec_json, out):
    spec = json.loads(spec_json)
    work = tempfile.mkdtemp()
    for sub in ("up", "wk"):
        os.makedirs(os.path.join(work, sub))
    subprocess.run(["mount", "-t", "overlay", "overlay", "-o", f"lowerdir=/etc,upperdir={work}/up,workdir={work}/wk", "/etc"], check=True)
    if spec["etc_hostname"] is not None:
        with open("/etc/hostname", "w") as handle:
            handle.write(spec["etc_hostname"])
    else:
        if os.path.exists("/etc/hostname"):
            os.unlink("/etc/hostname")
    if os.path.exists("/etc/machine-info"):
        os.unlink("/etc/machine-info")
    if spec["machine_info"] is not None:
        with open("/etc/machine-info", "w") as handle:
            handle.write(spec["machine_info"])
    with open("/etc/os-release", "w") as handle:
        handle.write(spec["os_release"])
    socket.sethostname(spec["kernel"])
    if spec["dmi"] is not None:
        subprocess.run(["mount", "-t", "tmpfs", "tmpfs", "/sys/class"], check=True)
        os.makedirs("/sys/class/dmi/id")
        for key, value in spec["dmi"].items():
            with open(f"/sys/class/dmi/id/{key}", "w") as handle:
                handle.write(value + "\n")
    shutil.rmtree(BUS_DIR, ignore_errors=True)
    os.makedirs(BUS_DIR, mode=0o777)
    os.chmod(BUS_DIR, 0o777)
    os.makedirs("/run/systemd/system", exist_ok=True)
    config = os.path.join(work, "bus.conf")
    with open(config, "w") as handle:
        handle.write(
            '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">\n'
            f"<busconfig><type>session</type><listen>unix:path={BUS_DIR}/bus</listen><auth>EXTERNAL</auth>"
            '<policy context="default"><allow user="*"/><allow own="*"/><allow send_type="method_call"/><allow send_type="signal"/><allow send_type="method_return"/>'
            '<allow send_type="error"/><allow receive_type="method_call"/><allow receive_type="signal"/><allow receive_type="method_return"/><allow receive_type="error"/></policy></busconfig>\n'
        )
    env = dict(os.environ, DBUS_SYSTEM_BUS_ADDRESS=f"unix:path={BUS_DIR}/bus", LANG="C.UTF-8", LC_ALL="C.UTF-8", SYSTEMD_COLORS="0", TERM="dumb", PATH="/usr/bin:/bin:/usr/sbin:/sbin")
    env.pop("SYSTEMD_LOG_LEVEL", None)
    processes = []
    processes.append(subprocess.Popen(["dbus-daemon", f"--config-file={config}", "--nofork", "--nopidfile", "--nosyslog"], env=env, stderr=subprocess.DEVNULL))
    for _ in range(50):
        if os.path.exists(f"{BUS_DIR}/bus"):
            break
        time.sleep(0.1)
    os.chmod(f"{BUS_DIR}/bus", 0o777)
    log_path = os.path.join(work, "hostnamed.log")
    log_handle = open(log_path, "w")
    processes.append(subprocess.Popen(["/usr/lib/systemd/systemd-hostnamed"], env=env, stderr=log_handle, stdout=subprocess.DEVNULL))
    manager = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "fake_systemd1.py"), f"{BUS_DIR}/bus", spec["virt"], spec["arch"]], env=env, stdout=subprocess.PIPE)
    manager.stdout.readline()
    processes.append(manager)
    processes.append(subprocess.Popen(["/usr/lib/polkit-1/polkitd", "--no-debug"], env=env, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL))
    time.sleep(2.5)
    read_so_far = 0
    runs = []
    for argv, uid in spec["runs"]:
        kwargs = {"user": uid, "group": uid, "extra_groups": []} if uid else {}
        process = subprocess.Popen(["hostnamectl", *argv], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, **kwargs)
        stdout, stderr = process.communicate(timeout=30)
        time.sleep(0.15)
        log_handle.flush()
        with open(log_path) as handle:
            handle.seek(read_so_far)
            logged = handle.read()
            read_so_far = handle.tell()
        runs.append({
            "argv": argv, "uid": uid, "stdout": stdout.decode(), "stderr": stderr.decode(), "rc": process.returncode,
            "etc_hostname": read_text("/etc/hostname"), "machine_info": read_text("/etc/machine-info"), "kernel": socket.gethostname(),
            "log": [line for line in logged.split("\n") if line],
        })
    for process in processes:
        process.terminate()
    with open(out, "w") as handle:
        json.dump(runs, handle)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--child":
        run_child(sys.argv[2], sys.argv[3])
        return
    recorded = []
    for scenario in scenario_list():
        scratch = tempfile.mkdtemp()
        os.chmod(scratch, 0o755)
        target = os.path.join(scratch, "runs.json")
        spec = dict(scenario)
        subprocess.run(["unshare", "-u", "-m", "-p", "-f", "--mount-proc", "--kill-child", "--propagation", "private", sys.executable, "-I", os.path.abspath(__file__), "--child", json.dumps(spec), target], check=True)
        with open(target) as handle:
            runs = json.load(handle)
        setup = {key: value for key, value in scenario.items() if key != "runs"}
        recorded.append({"setup": setup, "runs": runs})
    version = subprocess.run(["hostnamectl", "--version"], capture_output=True, text=True).stdout
    with open(sys.argv[1], "w") as handle:
        json.dump({"tool": "hostnamectl " + version.split("\n")[0], "scenarios": recorded}, handle, indent=1, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
