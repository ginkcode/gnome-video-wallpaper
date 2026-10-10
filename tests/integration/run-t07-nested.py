#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
UUID = "t07-fixture@ginkcode.github.io"
MODES = ["behavior", "normal-idle", "normal-loaded", "abnormal-idle", "abnormal-loaded"]
LIBS = ["playerProcess.js", "playerLifecycle.js", "mpvArgs.js", "mpvIpc.js", "log.js", "async.js"]


def command(*args):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, check=True).stdout


def state(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except OSError:
        return None


def private(pid, runtime):
    try:
        return f"XDG_RUNTIME_DIR={runtime}".encode() in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return False


def shell_pid(runtime):
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if (entry / 'comm').read_text().strip() == 'gnome-shell' and private(int(entry.name), runtime):
                return int(entry.name)
        except OSError:
            pass
    return None


def kill_private(pid, runtime):
    if not pid:
        return
    try:
        fd = os.pidfd_open(pid)
        try:
            if private(pid, runtime) and state(pid) not in (None, 'Z'):
                signal.pidfd_send_signal(fd, signal.SIGKILL)
        finally:
            os.close(fd)
    except ProcessLookupError:
        pass


def run_mode(base, mode, asset, options):
    runtime = base / f"r{MODES.index(mode)}"
    runtime.mkdir(mode=0o700)
    env = {
        'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
        'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
        'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
        'GSETTINGS_BACKEND': 'keyfile', 'T07_MODE': mode, 'T07_ASSET': str(asset),
        'T07_VO': options.vo, 'T07_LOW_PRIORITY': 'true',
    }
    events, lines, pids = [], [], set()
    ready = threading.Event()
    proc = subprocess.Popen(['dbus-run-session', '--', 'gnome-shell', '--headless',
                             '--virtual-monitor=1024x768'], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def pump():
        for line in proc.stdout:
            lines.append(line.rstrip())
            if 'T07_RESULT ' not in line:
                continue
            try:
                event = json.loads(line.split('T07_RESULT ', 1)[1])
            except json.JSONDecodeError:
                continue
            events.append(event)
            if event.get('event') == 'spawn':
                pids.add(int(event['pid']))
            if event.get('event') == 'lifetime-ready':
                ready.set()

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    error = None
    killed = None
    try:
        if mode.startswith('abnormal'):
            deadline = time.monotonic() + 25
            while not ready.wait(0.1):
                if proc.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('missing lifetime-ready')
            pid = shell_pid(runtime)
            if not pid:
                raise RuntimeError('private Shell PID not found')
            kill_private(pid, runtime)
            killed = pid
        proc.wait(timeout=25)
        time.sleep(2)
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        error = str(exc)
    finally:
        kill_private(shell_pid(runtime), runtime)
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=10)
    # A surviving player's stdout fd may keep the reader open until cleanup.
    survivors = [pid for pid in pids if state(pid) not in (None, 'Z')]
    for pid in pids:
        kill_private(pid, runtime)
    thread.join(timeout=2)
    result = {'mode': mode, 'shell_returncode': proc.returncode,
              'abnormal_shell_pid': killed, 'spawned_pids': sorted(pids),
              'surviving_pids_before_cleanup': survivors, 'error': error,
              'events': events, 'log_tail': lines[-20:]}
    expected = 'complete' if mode == 'behavior' else 'lifetime-ready'
    result['passed'] = (error is None and not survivors and
                        any(e.get('event') == expected for e in events) and
                        not any(e.get('event') == 'fail' for e in events))
    return result


def main():
    parser = argparse.ArgumentParser(description='Private headless GNOME Shell T07 verification')
    parser.add_argument('--vo', default='wlshm')
    options = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='t07-', dir='/tmp') as directory:
        base = Path(directory)
        for name in ('home', 'data', 'config', 'cache'):
            (base / name).mkdir(mode=0o700)
        asset = base / 'test.mp4'
        command('ffmpeg', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=10',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(asset))
        extension = base / 'data/gnome-shell/extensions' / UUID
        (extension / 'lib').mkdir(parents=True)
        (extension / 'metadata.json').write_text(json.dumps({
            'uuid': UUID, 'name': 'T07 fixture', 'description': 'Isolated verification',
            'shell-version': ['50']}))
        shutil.copy(ROOT / 'tests/integration/t07-extension.js', extension / 'extension.js')
        for name in LIBS:
            shutil.copy(ROOT / 'lib' / name, extension / 'lib' / name)
        settings = base / 'config/glib-2.0/settings'
        settings.mkdir(parents=True)
        (settings / 'keyfile').write_text(f"[org/gnome/shell]\nenabled-extensions=['{UUID}']\ndisable-user-extensions=false\n")
        versions = {name: command(name, '--version').splitlines()[0]
                    for name in ('gnome-shell', 'gjs', 'mpv', 'setpriv')}
        results = {'versions': versions, 'options': vars(options), 'modes': []}
        for mode in MODES:
            print(f'Running {mode}', flush=True)
            results['modes'].append(run_mode(base, mode, asset, options))
        print(json.dumps(results, indent=2))
        return 0 if all(result['passed'] for result in results['modes']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
