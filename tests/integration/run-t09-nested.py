#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = spec_from_file_location('t07_runner', ROOT / 'tests/integration/run-t07-nested.py')
t07 = module_from_spec(spec)
spec.loader.exec_module(t07)
UUID = 'gink-video-wallpaper@ginkcode.github.io'
PROBE = 't09-probe@ginkcode.github.io'
VIRTUAL_ID = 'Meta-0:MetaVendor:MetaVirtualMonitor:0x00'


def monitor_configs(path):
    configs = {VIRTUAL_ID: {'file': str(path), 'fitMode': None, 'optimize': None}}
    return f"monitor-configs='{json.dumps(configs)}'\n"


def command(base, *args):
    with (base / 'commands.log').open('ab') as log:
        log.write((repr(args) + '\n').encode())
        return subprocess.run(args, cwd=base, stdout=subprocess.PIPE, stderr=log,
                              check=True, timeout=60).stdout


def events_from(text):
    events = []
    for line in text.splitlines():
        if 'T09_RESULT ' in line:
            try:
                events.append(json.loads(line.split('T09_RESULT ', 1)[1]))
            except json.JSONDecodeError:
                pass
    return events


def players(runtime):
    found = set()
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            argv = (entry / 'cmdline').read_bytes().split(b'\0')
        except OSError:
            continue
        pid = int(entry.name)
        if (any(arg.startswith(b'--input-ipc-server=') for arg in argv) and
                t07.private(pid, runtime) and t07.state(pid) not in (None, 'Z')):
            found.add(pid)
    return found


class Monitor(threading.Thread):
    def __init__(self, runtime):
        super().__init__(daemon=True)
        self.runtime = runtime
        self.seen = set()
        self.max_concurrent = 0
        self.overlaps = []
        self.done = threading.Event()

    def run(self):
        while not self.done.is_set():
            alive = players(self.runtime)
            self.seen |= alive
            if len(alive) > 1:
                self.overlaps.append(sorted(alive))
            self.max_concurrent = max(self.max_concurrent, len(alive))
            time.sleep(0.005)


def pixel(base, path):
    data = command(base, 'ffmpeg', '-v', 'error', '-i', str(path), '-vf',
                   'crop=1:1:512:384,format=rgb24', '-f', 'rawvideo', '-')
    return list(data[:3])


def run_session(base, mode, asset, still, cycles, video_output):
    root = base / mode
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp'):
        (root / name).mkdir(mode=0o700, parents=True)
    extensions = root / 'data/gnome-shell/extensions'
    target = extensions / UUID
    target.mkdir(parents=True)
    for name in ('metadata.json', 'extension.js'):
        shutil.copy(ROOT / name, target / name)
    shutil.copytree(ROOT / 'lib', target / 'lib')
    (target / 'schemas').mkdir()
    shutil.copy(next((ROOT / 'schemas').glob('*.gschema.xml')), target / 'schemas')
    command(base, 'glib-compile-schemas', '--strict', str(target / 'schemas'))
    probe = extensions / PROBE
    probe.mkdir()
    (probe / 'metadata.json').write_text(json.dumps({
        'uuid': PROBE, 'name': 'T09 probe', 'description': 'Private verification', 'shell-version': ['50']}))
    shutil.copy(ROOT / 'tests/integration/t09-probe.js', probe / 'extension.js')
    settings = root / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=['{PROBE}']\ndisable-user-extensions=false\n"
        f"[org/gnome/shell/extensions/gink-video-wallpaper]\nvideo-output='{video_output}'\n" + monitor_configs(asset))
    runtime = root / 'runtime'
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(root / 'home'),
           'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(root / 'data'),
           'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache'),
           'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(root / 'tmp'),
           'GSETTINGS_BACKEND': 'keyfile', 'T09_OUTPUT': str(root), 'T09_EXIT': mode, 'T09_CYCLES': str(cycles)}
    monitor = Monitor(runtime)
    monitor.start()
    lines = []
    shell = None
    proc = subprocess.Popen(['dbus-run-session', '--', 'gnome-shell', '--headless',
                             '--virtual-monitor=1024x768'], env=env, cwd=root, start_new_session=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    deadline = time.monotonic() + 240
    killed_at = None
    try:
        for line in proc.stdout:
            lines.append(line)
            if 'T09_RESULT' in line and '"ready-for-exit"' in line and mode == 'abnormal':
                shell = t07.shell_pid(runtime)
                if shell:
                    killed_at = time.monotonic()
                    t07.kill_private(shell, runtime)
            if time.monotonic() > deadline:
                break
        proc.wait(timeout=30)
    finally:
        time.sleep(2)
        monitor.done.set()
        monitor.join()
        survivors = sorted(players(runtime))
        for pid in survivors:
            t07.kill_private(pid, runtime)
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                pass
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
    text = ''.join(lines)
    (root / 'shell.log').write_text(text)
    events = events_from(text)
    messages = [line.strip() for line in lines
                if '[gink-vw]' in line or 'JS ERROR' in line or 'Gjs-CRITICAL' in line]
    captures = {path.stem: pixel(base, path) for path in sorted(root.glob('*.png'))}
    return {'mode': mode, 'returncode': proc.returncode, 'killed': killed_at is not None,
            'events': events, 'extensionMessages': messages, 'captures': captures,
            'playerPids': sorted(monitor.seen), 'maxConcurrentPlayers': monitor.max_concurrent,
            'overlaps': monitor.overlaps[:5], 'survivors': survivors,
            'remainingSockets': sorted(p.name for p in (runtime / 'gink-video-wallpaper').glob('*'))
            if (runtime / 'gink-video-wallpaper').exists() else []}


def green(rgb):
    return len(rgb) == 3 and rgb[1] > 180 and rgb[0] < 60 and rgb[2] < 90


def evaluate(session, cycles):
    events = {e['event']: e for e in session['events']}
    checks = {}
    playing = events.get('playing', {})
    checks['plays'] = (green(session['captures'].get('playing', [])) and
                       not green(session['captures'].get('before-enable', [])) and
                       playing.get('playback', {}).get('advancing') is True and
                       playing.get('playback', {}).get('pause') is False and
                       playing.get('focused') is False and playing.get('skipTaskbar') is True)
    pause = events.get('pause-reasons', {})
    one, cleared = pause.get('oneReason', {}), pause.get('cleared', {})
    checks['pauseReasons'] = (one.get('pause') is True and one.get('advancing') is False and
                              one.get('state') == 'paused' and cleared.get('pause') is False and
                              cleared.get('advancing') is True and cleared.get('state') == 'playing')
    audit = events.get('audit', {})
    checks['cycles'] = (events.get('cycles', {}).get('cycles') == cycles and
                        events.get('after-cycles', {}).get('playback', {}).get('advancing') is True and
                        audit.get('reaped') is True and audit.get('sockets') == [] and
                        audit.get('children') == audit.get('baseline') and
                        not green(session['captures'].get('after-disable', [])))
    checks['noOverlap'] = session['maxConcurrentPlayers'] <= 1
    checks['noErrors'] = not session['extensionMessages'] and 'fail' not in events
    checks['exitLifetime'] = 'ready-for-exit' in events and not session['survivors'] and (
        session['returncode'] == 0 if session['mode'] == 'normal' else session['killed'])
    return checks


def main():
    parser = argparse.ArgumentParser(description='Private headless GNOME Shell T09 verification')
    parser.add_argument('--keep', action='store_true')
    parser.add_argument('--cycles', type=int, default=50)
    parser.add_argument('--modes', default='normal,abnormal')
    parser.add_argument('--video-output', default='auto')
    options = parser.parse_args()
    base = Path(tempfile.mkdtemp(prefix='t09-', dir='/tmp'))
    print(f'T09 fixture: {base}', flush=True)
    try:
        asset, still = base / 'selected.mp4', base / 'selected.png'
        command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=0x22cc44:size=320x240:rate=30:duration=4',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(asset))
        command(base, 'ffmpeg', '-y', '-i', str(asset), '-frames:v', '1', str(still))
        results = []
        for mode in options.modes.split(','):
            session = run_session(base, mode, asset, still, options.cycles, options.video_output)
            session['checks'] = evaluate(session, options.cycles)
            results.append(session)
        verified = all(all(s['checks'].values()) for s in results)
        summary = {'status': 'verified' if verified else 'failed', 'fixture': str(base),
                   'sessions': results}
        (base / 'result.json').write_text(json.dumps(summary, indent=2))
        for s in results:
            print(s['mode'], s['returncode'], s['checks'], 'players', len(s['playerPids']),
                  'max', s['maxConcurrentPlayers'], 'survivors', s['survivors'])
            for message in s['extensionMessages'][:20]:
                print('  ', message)
            for event in s['events']:
                if event['event'] in ('playing', 'pause-reasons', 'cycles', 'audit', 'fail'):
                    print('  ', json.dumps(event)[:600])
        print(summary['status'])
        return 0 if verified else 1
    finally:
        if options.keep:
            print(f'Retained T09 evidence: {base}', flush=True)
        else:
            shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
