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
import zipfile

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = spec_from_file_location('t09_runner', ROOT / 'tests/integration/run-t09-nested.py')
t09 = module_from_spec(spec)
spec.loader.exec_module(t09)
UUID = 'gink-video-wallpaper@ginkcode.github.io'
PROBE = 't28-probe@ginkcode.github.io'
ZIP = ROOT / 'dist' / f'{UUID}.shell-extension.zip'


def environment(base):
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
            'XDG_RUNTIME_DIR': str(base / 'runtime'), 'XDG_DATA_HOME': str(base / 'data'),
            'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
            'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(base / 'tmp'),
            'GSETTINGS_BACKEND': 'keyfile'}


def install(base, env):
    subprocess.run(['dbus-run-session', '--', 'gnome-extensions', 'install', '--force', str(ZIP)],
                   env=env, cwd=base, check=True, capture_output=True)
    target = base / 'data/gnome-shell/extensions' / UUID
    return sorted(str(path.relative_to(target)) for path in target.rglob('*') if path.is_file())


def session(base, asset):
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp'):
        (base / name).mkdir(mode=0o700)
    env = environment(base)
    installed = install(base, env)
    probe = base / 'data/gnome-shell/extensions' / PROBE
    probe.mkdir()
    (probe / 'metadata.json').write_text(json.dumps({
        'uuid': PROBE, 'name': 'T28 probe', 'description': 'Private verification', 'shell-version': ['50']}))
    shutil.copy(ROOT / 'tests/integration/t28-probe.js', probe / 'extension.js')
    configs = {t09.VIRTUAL_ID: {'files': [asset], 'fitMode': None, 'optimize': None}}
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=['{PROBE}']\ndisable-user-extensions=false\n"
        "[org/gnome/desktop/background]\npicture-uri='file:///orig/light.png'\n"
        "picture-uri-dark='file:///orig/dark.png'\npicture-options='spanned'\n"
        "[org/gnome/shell/extensions/gink-video-wallpaper]\nstartup-delay-ms=uint32 0\n"
        f"monitor-configs='{json.dumps(configs)}'\n")
    runtime = base / 'runtime'
    monitor = t09.Monitor(runtime)
    monitor.start()
    proc = subprocess.Popen(['dbus-run-session', '--', 'gnome-shell', '--headless',
                             '--virtual-monitor=1024x768'], env=env, cwd=base, start_new_session=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    try:
        out, _ = proc.communicate(timeout=120)
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
        if 'T28_RESULT ' in line:
            event = json.loads(line.split('T28_RESULT ', 1)[1])
            events[event['event']] = event
    messages = [line.strip() for line in (out or '').splitlines()
                if '[gink-vw]' in line or 'JS ERROR' in line]
    return installed, events, messages, survivors


def main():
    subprocess.run(['make', '-s', 'zip'], cwd=ROOT, check=True, capture_output=True)
    with zipfile.ZipFile(ZIP) as archive:
        packed = sorted(archive.namelist())
    base = Path(tempfile.mkdtemp(prefix='t28-', dir='/tmp'))
    try:
        asset = base / 'green.mp4'
        t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=0x22cc44:size=320x240:rate=30:duration=4',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(asset))
        installed, events, messages, survivors = session(base, str(asset))
        steps = events.get('steps', {})
        checks = {
            'zipHasLicense': 'LICENSE' in packed,
            'zipHasNoStrayFiles': not any(name.endswith(('.gitkeep', '.compiled')) for name in packed),
            'schemaCompiledOnInstall': 'schemas/gschemas.compiled' in installed,
            'installedFromZip': (steps.get('installed') or {}).get('path', '').startswith(str(base / 'data')),
            'versionName': (steps.get('installed') or {}).get('version') == '1.0',
            'active': steps.get('stateEnabled') == 1,
            'playing': steps.get('playing') is True,
            'indicator': steps.get('indicator') is True,
            'disableCleansUp': steps.get('stopped') is True and steps.get('indicatorRemoved') is True,
            'noSurvivors': not survivors,
            'noJsErrors': not any('JS ERROR' in m for m in messages) and 'fail' not in events,
        }
        print(json.dumps({'checks': checks, 'packed': packed, 'events': events, 'messages': messages[:20]}, indent=1))
        return 0 if all(checks.values()) else 1
    finally:
        shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
