#!/usr/bin/env python3
import json
from pathlib import Path
import os
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SMOKE = ROOT / 'tests/integration/t21-prefs-smoke.js'
SCRIPT = '''
gnome-shell --headless --virtual-monitor=1024x768 >"$1/shell.log" 2>&1 &
shell=$!
for _ in $(seq 150); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
sleep 2
WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland GSETTINGS_BACKEND=memory gjs -m "$2" "$3" "$4" "$5"
kill "$shell"
wait "$shell"
'''


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', *args], check=True, timeout=60)


def media(directory):
    source = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=1']
    x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
    ffmpeg(*source, *x264, str(directory / 'plain.mp4'))
    ffmpeg(*source, '-vf', 'setsar=4/3', *x264, str(directory / 'sar.mp4'))
    ffmpeg('-display_rotation', '90', '-i', str(directory / 'plain.mp4'), '-c', 'copy', str(directory / 'rot.mp4'))
    ffmpeg(*source, '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', *x264,
           str(directory / 'hdr.mp4'))
    (directory / 'notes.txt').write_text('not a video\n')


def main():
    base = Path(tempfile.mkdtemp(prefix='gink-vw-t21-'))
    try:
        for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp', 'media', 'schemas'):
            (base / name).mkdir(mode=0o700)
        media(base / 'media')
        shutil.copy(next((ROOT / 'schemas').glob('*.gschema.xml')), base / 'schemas')
        subprocess.run(['glib-compile-schemas', '--strict', str(base / 'schemas')], check=True)
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
               'XDG_RUNTIME_DIR': str(base / 'runtime'), 'XDG_DATA_HOME': str(base / 'data'),
               'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
               'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(base / 'tmp'),
               'GSETTINGS_BACKEND': 'keyfile'}
        screenshot = Path(os.environ.get('T21_SCREENSHOT', base / 'prefs.png'))
        proc = subprocess.Popen(['dbus-run-session', '--', 'bash', '-c', SCRIPT, 'run', str(base), str(SMOKE),
                                 str(base / 'schemas'), str(base / 'media'), str(screenshot)],
                                env=env, cwd=ROOT, start_new_session=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors='replace')
        try:
            out, _ = proc.communicate(timeout=180)
        except subprocess.TimeoutExpired:
            out = ''
        finally:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(proc.pid, sig)
                except ProcessLookupError:
                    pass
        events = {}
        for line in out.splitlines():
            if 'T21_RESULT ' in line:
                event = json.loads(line.split('T21_RESULT ', 1)[1])
                events.setdefault(event['event'], []).append(event)
            elif 'CRITICAL' in line or 'WARNING' in line or 'JS ERROR' in line:
                print('LOG', line)
        print(json.dumps(events, indent=1))
        return 0 if events.get('closed') and 'error' not in events else 1
    finally:
        if not os.environ.get('T21_KEEP'):
            shutil.rmtree(base)


sys.exit(main())
