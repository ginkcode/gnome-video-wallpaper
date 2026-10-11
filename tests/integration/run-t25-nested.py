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
import time

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = spec_from_file_location('t09_runner', ROOT / 'tests/integration/run-t09-nested.py')
t09 = module_from_spec(spec)
spec.loader.exec_module(t09)
UUID = 'gink-video-wallpaper@ginkcode.github.io'
PROBE = 't25-probe@ginkcode.github.io'
SMOKE = ROOT / 'tests/integration/t25-smoke.js'
SCRIPT = '''
gnome-shell --headless --virtual-monitor=1920x1080 --virtual-monitor=1920x1080 >"$1/shell.log" 2>&1 &
shell=$!
for _ in $(seq 150); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
sleep 2
timeout 540 gjs -m "$2" "$3" "$4" "$5" "$6"
kill "$shell"
wait "$shell"
'''


def setup(base):
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp', 'captures'):
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
        'uuid': PROBE, 'name': 'T25 probe', 'description': 'Private multi-monitor verification',
        'shell-version': ['50']}))
    shutil.copy(ROOT / 'tests/integration/t25-probe.js', probe / 'extension.js')
    media = base / 'media'
    media.mkdir()
    for name, color in (('a', 'red'), ('b', 'lime'), ('c', 'blue'), ('d', 'yellow')):
        t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', f'color=c={color}:size=320x240:rate=30:duration=4',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', str(media / f'{name}.mp4'))
    original = base / 'original.png'
    t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=magenta:size=64x64', '-frames:v', '1',
                str(original))
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=['{UUID}', '{PROBE}']\ndisable-user-extensions=false\n"
        f"[org/gnome/desktop/background]\npicture-uri='file://{original}'\n"
        f"picture-uri-dark='file://{original}'\npicture-options='zoom'\n"
        "[org/gnome/shell/extensions/gink-video-wallpaper]\nstartup-delay-ms=uint32 0\n")
    return target / 'schemas', media


def main():
    parser = argparse.ArgumentParser(description='Private headless two-monitor T25 smoke')
    parser.add_argument('--keep', action='store_true', help='retain fixture directory and captures')
    parser.add_argument('--log', action='store_true', help='print the shell log tail')
    parser.add_argument('--quick', action='store_true', help='only run the window raster layouts')
    options = parser.parse_args()
    base = Path(tempfile.mkdtemp(prefix='t25-', dir='/tmp'))
    try:
        schemas, media = setup(base)
        runtime = base / 'runtime'
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
               'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
               'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
               'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(base / 'tmp'),
               'GSETTINGS_BACKEND': 'keyfile'}
        proc = subprocess.Popen(['dbus-run-session', '--', 'bash', '-c', SCRIPT, 'run', str(base), str(SMOKE),
                                 str(schemas), str(media), str(base / 'captures'), 'quick' if options.quick else 'full'],
                                env=env, cwd=ROOT, start_new_session=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors='replace')
        try:
            out, _ = proc.communicate(timeout=600)
        except subprocess.TimeoutExpired:
            out = ''
        finally:
            time.sleep(1)
            survivors = sorted(t09.players(runtime))
            for pid in survivors:
                t09.t07.kill_private(pid, runtime)
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(proc.pid, sig)
                except ProcessLookupError:
                    pass
        steps, events, errors = [], {}, []
        for line in out.splitlines():
            if 'T25_RESULT ' in line:
                event = json.loads(line.split('T25_RESULT ', 1)[1])
                if event['event'] == 'step':
                    steps.append(event)
                events[event['event']] = event
            elif 'JS ERROR' in line or 'CRITICAL' in line:
                errors.append(line.strip())
        shell_log = (base / 'shell.log').read_text(errors='replace') if (base / 'shell.log').exists() else ''
        errors += [line.strip() for line in shell_log.splitlines()
                   if 'JS ERROR' in line or ('[gink-vw]' in line and ('ERROR' in line or 'failed' in line))]
        checks = dict(events.get('checks', {}).get('checks', {}))
        checks['noDriverError'] = 'error' not in events
        checks['noSurvivors'] = not survivors
        checks['noShellErrors'] = not errors
        for step in steps:
            print(f"{step['label']}: ok={step['ok']} settled={step.get('settled')} players="
                  f"{[(p['source'], p['pid']) for p in step['players']]} sockets={step['sockets']}")
            for area in step['areas']:
                print(f"   {area['key']} {area['rect']} want={area['want']} filled={area['filled']} "
                      f"clone={area['cloneMatches']} colors={sorted(set(area['colors']))}")
            for raster in step['raster']:
                print(f"   raster {raster}")
            print(f"   clones={[(c['x'], c['y'], c['width'], c['height'], c['visible']) for c in step['clones']]}"
                  f" windows={[(w['pid'], w['x'], w['y'], w['width'], w['height']) for w in step['windows']]}")
            for layer in step.get('layers', []):
                print(f"   layer {layer}")
        for line in errors[:20]:
            print('ERR', line[:400])
        if 'error' in events:
            print('DRIVER ERROR', json.dumps(events['error'])[:2000])
        if options.log:
            print(shell_log[-20000:])
        (base / 'result.json').write_text(json.dumps({'checks': checks, 'steps': steps, 'events': events,
                                                      'survivors': survivors, 'errors': errors}, indent=1))
        print(json.dumps({'checks': checks, 'survivors': survivors}, indent=1))
        verified = bool(checks) and all(checks.values())
        print('verified' if verified else 'failed')
        return 0 if verified else 1
    finally:
        if options.keep:
            print(f'Retained T25 evidence: {base}')
        else:
            shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
