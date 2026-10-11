#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = spec_from_file_location('t09_runner', ROOT / 'tests/integration/run-t09-nested.py')
t09 = module_from_spec(spec)
spec.loader.exec_module(t09)
UUID = 'gink-video-wallpaper@ginkcode.github.io'
PROBE = 't30-probe@ginkcode.github.io'


def session(base, assets):
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp'):
        (base / name).mkdir(mode=0o700)
    extensions = base / 'data/gnome-shell/extensions'
    target = extensions / UUID
    target.mkdir(parents=True)
    for name in ('metadata.json', 'extension.js'):
        shutil.copy(ROOT / name, target / name)
    shutil.copytree(ROOT / 'lib', target / 'lib')
    (target / 'schemas').mkdir()
    shutil.copy(next((ROOT / 'schemas').glob('*.gschema.xml')), target / 'schemas')
    t09.command(base, 'glib-compile-schemas', '--strict', str(target / 'schemas'))
    probe = extensions / PROBE
    probe.mkdir()
    (probe / 'metadata.json').write_text(json.dumps({
        'uuid': PROBE, 'name': 'T30 probe', 'description': 'Private verification', 'shell-version': ['50']}))
    shutil.copy(ROOT / 'tests/integration/t30-probe.js', probe / 'extension.js')
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=['{PROBE}']\ndisable-user-extensions=false\n"
        "[org/gnome/desktop/background]\npicture-uri='file:///orig/light.png'\n"
        "picture-uri-dark='file:///orig/dark.png'\npicture-options='spanned'\n"
        "[org/gnome/shell/extensions/gink-video-wallpaper]\nstartup-delay-ms=uint32 0\n" +
        playlist_configs(assets))
    runtime = base / 'runtime'
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
           'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
           'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
           'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(base / 'tmp'),
           'GSETTINGS_BACKEND': 'keyfile'}
    monitor = t09.Monitor(runtime)
    monitor.start()
    proc = subprocess.Popen(['dbus-run-session', '--', 'gnome-shell', '--headless',
                             '--virtual-monitor=1024x768'], env=env, cwd=base, start_new_session=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    try:
        out, _ = proc.communicate(timeout=240)
    except subprocess.TimeoutExpired:
        out = ''
    finally:
        time.sleep(1)
        monitor.done.set()
        monitor.join()
        survivors = sorted(t09.players(runtime))
        for pid in survivors:
            t09.t07.kill_private(pid, runtime)
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                pass
    events = {}
    for line in (out or '').splitlines():
        if 'T30_RESULT ' in line:
            event = json.loads(line.split('T30_RESULT ', 1)[1])
            events[event['event']] = event
    messages = [line.strip() for line in (out or '').splitlines()
                if '[gink-vw]' in line or 'JS ERROR' in line]
    return events, messages, monitor, survivors


def playlist_configs(assets):
    configs = {t09.VIRTUAL_ID: {'files': [str(path) for path in assets], 'fitMode': None, 'optimize': None}}
    return f"monitor-configs='{json.dumps(configs)}'\n"


def main():
    base = Path(tempfile.mkdtemp(prefix='t30-', dir='/tmp'))
    try:
        assets = []
        for name, colour in (('green', '0x22cc44'), ('red', '0xcc2222'), ('blue', '0x2244cc')):
            asset = base / f'{name}.mp4'
            t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', f'color=c={colour}:size=320x240:rate=30:duration=4',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(asset))
            assets.append(str(asset))
        events, messages, monitor, survivors = session(base, assets)
        steps = events.get('steps', {})
        files = [Path(path).stem if path else None for path in steps.get('files', [])]
        checks = {
            'startsAtFirst': files[:1] == ['green'],
            'advanceInOrder': files[1:4] == ['red', 'blue', 'green'],
            'menuNextAdvances': files[4:5] == ['red'],
            'eachChangePlays': steps.get('states') == ['playing'] * 5 and len(set(steps.get('pids', []))) == 5,
            'positionPersisted': Path(steps.get('saved') or '/x').stem == 'red',
            'resumesAfterReenable': Path(steps.get('reenabled') or '/x').stem == 'red',
            'pausedStaysPaused': steps.get('pausedAdvance') == {'file': 'blue', 'state': 'paused'},
            'noSurvivors': not survivors,
            'noJsErrors': not any('JS ERROR' in m for m in messages) and 'fail' not in events,
        }
        print(json.dumps({'checks': checks, 'events': events, 'messages': messages[:20]}, indent=1))
        return 0 if all(checks.values()) else 1
    finally:
        shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
