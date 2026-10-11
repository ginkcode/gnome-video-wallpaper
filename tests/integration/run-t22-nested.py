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
SMOKE = ROOT / 'tests/integration/t22-prefs-smoke.js'
SCRIPT = '''
gnome-shell --headless --virtual-monitor=1024x768 >"$1/shell.log" 2>&1 &
shell=$!
for _ in $(seq 150); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
sleep 2
WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland gjs -m "$2" "$3" "$4"
kill "$shell"
wait "$shell"
'''


def setup(base):
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp', 'bin'):
        (base / name).mkdir(mode=0o700)
    target = base / 'data/gnome-shell/extensions' / UUID
    target.mkdir(parents=True)
    for name in ('metadata.json', 'extension.js'):
        shutil.copy(ROOT / name, target / name)
    shutil.copytree(ROOT / 'lib', target / 'lib')
    (target / 'schemas').mkdir()
    shutil.copy(next((ROOT / 'schemas').glob('*.gschema.xml')), target / 'schemas')
    t09.command(base, 'glib-compile-schemas', '--strict', str(target / 'schemas'))
    asset = base / 'selected.mp4'
    t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(asset))
    stale = base / 'cache/gink-video-wallpaper/stills'
    stale.mkdir(parents=True)
    (stale / 'stale.png').write_bytes(b'\0' * 4096)
    for name in ('ffmpeg', 'ffprobe'):
        (base / 'bin' / name).symlink_to(shutil.which(name))
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=['{UUID}']\ndisable-user-extensions=false\n"
        "[org/gnome/desktop/background]\npicture-uri='file:///orig/light.png'\n"
        "picture-uri-dark='file:///orig/dark.png'\npicture-options='spanned'\n"
        "[org/gnome/shell/extensions/gink-video-wallpaper]\nstartup-delay-ms=uint32 0\n" +
        t09.monitor_configs(asset))
    return target / 'schemas', asset


def main():
    base = Path(tempfile.mkdtemp(prefix='t22-', dir='/tmp'))
    try:
        schemas, asset = setup(base)
        runtime = base / 'runtime'
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
               'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
               'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
               'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(base / 'tmp'),
               'GSETTINGS_BACKEND': 'keyfile'}
        proc = subprocess.Popen(['dbus-run-session', '--', 'bash', '-c', SCRIPT, 'run', str(base), str(SMOKE),
                                 str(schemas), str(base / 'bin')],
                                env=env, cwd=ROOT, start_new_session=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors='replace')
        try:
            out, _ = proc.communicate(timeout=240)
        except subprocess.TimeoutExpired:
            out = ''
        finally:
            time.sleep(1)
            for pid in sorted(t09.players(runtime)):
                t09.t07.kill_private(pid, runtime)
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(proc.pid, sig)
                except ProcessLookupError:
                    pass
        events = {}
        for line in out.splitlines():
            if 'T22_RESULT ' in line:
                event = json.loads(line.split('T22_RESULT ', 1)[1])
                events[event['event']] = event
            elif 'JS ERROR' in line or 'Gtk-CRITICAL' in line or 'Adwaita-CRITICAL' in line:
                print('LOG', line)
        general = events.get('general', {}).get('keys', {})
        diag = events.get('diagnostics', {}).get('rows', {})
        limited = events.get('withoutMpv', {})
        clear = events.get('clear', {})
        before, after = clear.get('before', {}), clear.get('after', {})
        checks = {
            'settingsRoundTrip': len(general) == 10 and all(v['ok'] and v['followsExternalReset']
                                                             for v in general.values()),
            'diagnosticsFound': all(diag.get(k, {}).get('icon') == 'object-select-symbolic' and diag[k]['version']
                                    for k in ('mpv', 'ffmpeg', 'ffprobe')),
            'mpvMissingShown': limited.get('rows', {}).get('mpv', {}).get('icon') == 'window-close-symbolic' and
            limited.get('rows', {}).get('ffmpeg', {}).get('icon') == 'object-select-symbolic' and
            limited.get('hint') == 'sudo apt install mpv',
            'clearKeepsPlayback': clear.get('playing') is True and before.get('players') and
            before.get('players') == after.get('players') and before.get('refs') == after.get('refs') and
            after.get('pictureExists') is True and after.get('pictureUri') == clear.get('pictureUri') and
            before.get('wallpapers') == after.get('wallpapers') and 'stale.png' in before.get('stills', []) and
            after.get('stills') == [],
            'clearReport': (clear.get('cleared') or {}).get('removedBytes', 0) >= 4096 and
            (clear.get('cleared') or {}).get('preservedActiveBytes', 0) > 0 and
            (clear.get('cleared') or {}).get('preservedWallpaperBytes', 0) > 0 and
            'Kept' in (clear.get('toast') or '') and before.get('size') != after.get('size') and
            clear.get('buttonSensitive') is True,
            'noErrors': 'error' not in events,
        }
        print(json.dumps({'checks': checks, 'events': events}, indent=1))
        return 0 if all(checks.values()) else 1
    finally:
        shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
