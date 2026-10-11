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
spec = spec_from_file_location('t27_runner', ROOT / 'tests/integration/run-t27-nested.py')
t27 = module_from_spec(spec)
spec.loader.exec_module(t27)
UUID = 'gink-video-wallpaper@ginkcode.github.io'
PROBE = 't31-probe@ginkcode.github.io'


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
    copied = []
    for uuid in t27.DEVICE:
        if (t27.USER_EXTENSIONS / uuid).is_dir():
            shutil.copytree(t27.USER_EXTENSIONS / uuid, extensions / uuid, symlinks=True)
            copied.append(uuid)
    enabled = ', '.join(f"'{uuid}'" for uuid in [PROBE] + copied)
    probe = extensions / PROBE
    probe.mkdir()
    (probe / 'metadata.json').write_text(json.dumps({
        'uuid': PROBE, 'name': 'T31 probe', 'description': 'Private verification', 'shell-version': ['50']}))
    shutil.copy(ROOT / 'tests/integration/t31-probe.js', probe / 'extension.js')
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=[{enabled}]\ndisable-user-extensions=false\n"
        "[org/gnome/desktop/background]\npicture-uri='file:///orig/light.png'\n"
        "picture-uri-dark='file:///orig/dark.png'\npicture-options='spanned'\n"
        "[org/gnome/shell/extensions/gink-video-wallpaper]\nstartup-delay-ms=uint32 0\n" +
        playlist_configs(assets) + t27.DEVICE_SETTINGS)
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
        if 'T31_RESULT ' in line:
            event = json.loads(line.split('T31_RESULT ', 1)[1])
            events[event['event']] = event
    messages = [line.strip() for line in (out or '').splitlines()
                if '[gink-vw]' in line or 'JS ERROR' in line]
    return events, messages, monitor, survivors


def playlist_configs(assets):
    configs = {t09.VIRTUAL_ID: {'files': [str(path) for path in assets], 'fitMode': None, 'optimize': None}}
    return f"monitor-configs='{json.dumps(configs)}'\n"


def main():
    base = Path(tempfile.mkdtemp(prefix='t31-', dir='/tmp'))
    try:
        asset = base / 'green.mp4'
        t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=0x22cc44:size=320x240:rate=30:duration=4',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(asset))
        events, messages, monitor, survivors = session(base, [str(asset)])
        steps = events.get('steps', {})
        away, back = steps.get('away', {}), steps.get('back', {})
        checks = {
            'clientFocused': steps.get('start') == {'active': 0, 'focus': 'gink-t31-client'},
            'switchesAway': away.get('visits') == [1] and away.get('active') == 1,
            'playerNotFocused': away.get('focus') is None,
            'stolenFocusStays': steps.get('stolen') == {'visits': [], 'active': 1, 'focus': None, 'attention': False},
            'switchesBack': back.get('visits') == [0] and back.get('active') == 0,
            'clientRefocused': back.get('focus') == 'gink-t31-client',
            'playerNotAnimated': away.get('ownedClones') == 0 and back.get('ownedClones') == 0,
            'restoredOnDisable': steps.get('restored') is True,
            'noSurvivors': not survivors,
            'noJsErrors': not any('JS ERROR' in m for m in messages) and 'fail' not in events,
        }
        print(json.dumps({'checks': checks, 'events': events, 'messages': messages[:20]}, indent=1))
        return 0 if all(checks.values()) else 1
    finally:
        shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
