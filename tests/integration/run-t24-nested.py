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
SMOKE = ROOT / 'tests/integration/t24-live-smoke.js'
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
    stage = target.parent / 't24-stage@ginkcode.github.io'
    stage.mkdir()
    (stage / 'metadata.json').write_text(json.dumps({
        'uuid': stage.name, 'name': 'T24 stage', 'description': 'Private headless paint driver',
        'shell-version': ['50']}))
    shutil.copy(ROOT / 'tests/integration/t24-stage.js', stage / 'extension.js')
    media = base / 'media'
    media.mkdir()
    for name, color in (('a', 'red'), ('b', 'green'), ('c', 'blue'), ('d', 'yellow')):
        t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', f'color=c={color}:size=320x240:rate=30:duration=4',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', str(media / f'{name}.mp4'))
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=['{UUID}', '{stage.name}']\ndisable-user-extensions=false\n"
        "[org/gnome/desktop/background]\npicture-uri='file:///orig/light.png'\n"
        "picture-uri-dark='file:///orig/dark.png'\npicture-options='spanned'\n"
        "[org/gnome/shell/extensions/gink-video-wallpaper]\nstartup-delay-ms=uint32 0\n" +
        t09.monitor_configs(media / 'a.mp4'))
    return target / 'schemas', media


def main():
    base = Path(tempfile.mkdtemp(prefix='t24-', dir='/tmp'))
    try:
        schemas, media = setup(base)
        runtime = base / 'runtime'
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
               'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
               'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
               'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(base / 'tmp'),
               'GSETTINGS_BACKEND': 'keyfile'}
        proc = subprocess.Popen(['dbus-run-session', '--', 'bash', '-c', SCRIPT, 'run', str(base), str(SMOKE),
                                 str(schemas), str(media)],
                                env=env, cwd=ROOT, start_new_session=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors='replace')
        try:
            out, _ = proc.communicate(timeout=360)
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
            if 'T24_RESULT ' in line:
                event = json.loads(line.split('T24_RESULT ', 1)[1])
                events[event['event']] = event
            elif 'JS ERROR' in line or 'CRITICAL' in line:
                print('LOG', line)
        if '--log' in sys.argv:
            print((base / 'shell.log').read_text(errors='replace')[-20000:])
        login, change, rapid = events.get('login', {}), events.get('change', {}), events.get('rapid', {})
        vo, fit = events.get('videoOutput', {}), events.get('fitMode', {})
        removed, readded = events.get('removed', {}), events.get('readded', {})
        published = lambda uri: (uri or '').startswith('file://' + str(base / 'data'))
        checks = {
            'loginFromConfig': login.get('login') is True and published(login.get('pictureUri')),
            'changeHandsOff': change.get('changed') is True and change.get('replaced') is True and
            change.get('maxPlayers') == 1 and change.get('maxSockets') == 1 and len(change.get('sockets', [])) == 1 and
            published(change.get('pictureUri')) and change.get('pictureUri') != login.get('pictureUri'),
            'rapidResolvesToFinal': rapid.get('rapid') is True and rapid.get('maxPlayers') == 1 and
            rapid.get('maxSockets') == 1 and len(rapid.get('sockets', [])) == 1,
            'videoOutputReplaces': vo.get('voChanged') is True and vo.get('replaced') is True and
            vo.get('voRestored') is True and vo.get('maxPlayers') == 1,
            'fitModeReplaces': fit.get('fitChanged') is True and fit.get('maxPlayers') == 1,
            'removeRestores': removed.get('stopped') is True and removed.get('players') == [] and
            removed.get('sockets') == [] and removed.get('refs') == [] and
            removed.get('pictureUri') == 'file:///orig/light.png' and removed.get('pictureOptions') == 'spanned' and
            removed.get('applied') is False,
            'readdApplies': readded.get('again') is True and published(readded.get('pictureUri')),
            'noErrors': 'error' not in events,
        }
        print(json.dumps({'checks': checks, 'events': events}, indent=1))
        return 0 if all(checks.values()) else 1
    finally:
        shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
