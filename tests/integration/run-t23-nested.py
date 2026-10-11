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
SMOKE = ROOT / 'tests/integration/t23-optimize-smoke.js'
SCRIPT = '''
gnome-shell --headless --virtual-monitor=1024x768 >"$1/shell.log" 2>&1 &
shell=$!
for _ in $(seq 150); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
sleep 2
WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland gjs -m "$2" "$3" "$4" "$5"
kill "$shell"
wait "$shell"
'''


def setup(base):
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp'):
        (base / name).mkdir(mode=0o700)
    target = base / 'data/gnome-shell/extensions' / UUID
    target.mkdir(parents=True)
    for name in ('metadata.json', 'extension.js'):
        shutil.copy(ROOT / name, target / name)
    shutil.copytree(ROOT / 'lib', target / 'lib')
    (target / 'schemas').mkdir()
    shutil.copy(next((ROOT / 'schemas').glob('*.gschema.xml')), target / 'schemas')
    t09.command(base, 'glib-compile-schemas', '--strict', str(target / 'schemas'))
    media = base / 'media'
    media.mkdir()
    lavfi = ['-f', 'lavfi', '-i']
    x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
    t09.command(base, 'ffmpeg', '-y', *lavfi, 'testsrc2=size=160x120:rate=10:duration=3', str(media / 'timing.gif'))
    t09.command(base, 'ffmpeg', '-y', *lavfi, 'testsrc2=size=320x240:rate=30:duration=2', *x264,
                str(media / 'plain.mp4'))
    t09.command(base, 'ffmpeg', '-y', *lavfi, 'testsrc2=size=1280x720:rate=30:duration=60', *x264,
                str(media / 'long.mp4'))
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=['{UUID}']\ndisable-user-extensions=false\n"
        "[org/gnome/desktop/background]\npicture-uri='file:///orig/light.png'\n"
        "picture-uri-dark='file:///orig/dark.png'\npicture-options='spanned'\n"
        "[org/gnome/shell/extensions/gink-video-wallpaper]\nstartup-delay-ms=uint32 0\n" +
        t09.monitor_configs(media / 'timing.gif'))
    return target / 'schemas', media


def main():
    base = Path(tempfile.mkdtemp(prefix='t23-', dir='/tmp'))
    try:
        schemas, media = setup(base)
        runtime = base / 'runtime'
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
               'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
               'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
               'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(base / 'tmp'),
               'GSETTINGS_BACKEND': 'keyfile'}
        proc = subprocess.Popen(['dbus-run-session', '--', 'bash', '-c', SCRIPT, 'run', str(base), str(SMOKE),
                                 str(schemas), str(media), UUID],
                                env=env, cwd=ROOT, start_new_session=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors='replace')
        try:
            out, _ = proc.communicate(timeout=300)
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
            if 'T23_RESULT ' in line:
                event = json.loads(line.split('T23_RESULT ', 1)[1])
                events[event['event']] = event
            elif 'JS ERROR' in line or 'Gtk-CRITICAL' in line or 'Adwaita-CRITICAL' in line:
                print('LOG', line)
        login = events.get('login', {})
        gif = events.get('gif', {})
        relogin = events.get('relogin', {})
        on = events.get('optimizeOn', {})
        cancelled = events.get('cancelled', {})
        players = lambda event: event.get('players') or [{}]
        checks = {
            'loginFallsBackWithoutTranscode': players(login)[0].get('source') == 'original' and
            login.get('media') == [],
            'gifSavedAfterTranscode': (gif.get('config') or {}).get('file', '').endswith('timing.gif') and
            gif.get('progress', 0) > 0 and gif.get('configDuringProgress') is False and len(gif.get('media', [])) == 1 and
            gif.get('progressHidden') is True and gif.get('toasts') == [],
            'shellPlaysOptimized': players(relogin)[0].get('source') == 'optimized' and players(relogin)[0].get('loop'),
            'optimizeToggle': (on.get('config') or {}).get('optimize') is True and on.get('optimized') is True and
            on.get('generation') == 1 and on.get('preview') == 'picture' and on.get('toasts') == [],
            'optimizedPublicationAppliesLive': on.get('liveOptimized') is True,
            'cancelLeavesNothing': cancelled.get('started') is True and cancelled.get('configs') == {} and
            cancelled.get('jobs') == [] and cancelled.get('mediaCount') == cancelled.get('before') and
            cancelled.get('progressHidden') is True,
            'closedClean': events.get('closed', {}).get('jobs') == [],
            'noErrors': 'error' not in events,
        }
        print(json.dumps({'checks': checks, 'events': events}, indent=1))
        return 0 if all(checks.values()) else 1
    finally:
        shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
