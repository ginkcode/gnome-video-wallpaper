#!/usr/bin/env python3
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location('t07_runner', ROOT / 'tests/integration/run-t07-nested.py')
t07 = module_from_spec(spec)
spec.loader.exec_module(t07)


def main():
    with tempfile.TemporaryDirectory(prefix='t08-', dir='/tmp') as directory:
        base = Path(directory)
        for name in ('home', 'data', 'config', 'cache'):
            (base / name).mkdir(mode=0o700)
        asset = base / 'selected.mp4'
        t07.command('ffmpeg', '-y', '-f', 'lavfi', '-i',
                    'color=c=0x22cc44:size=320x240:rate=60:duration=2',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(asset))
        still = base / 'selected.png'
        t07.command('ffmpeg', '-y', '-i', str(asset), '-frames:v', '1', str(still))
        uuid = 't08-fixture@ginkcode.github.io'
        extension = base / 'data/gnome-shell/extensions' / uuid
        (extension / 'lib').mkdir(parents=True)
        (extension / 'metadata.json').write_text(json.dumps({
            'uuid': uuid, 'name': 'T08 fixture', 'description': 'Private feasibility verification',
            'shell-version': ['50']}))
        shutil.copy(ROOT / 'tests/integration/t08-extension.js', extension / 'extension.js')
        for name in t07.LIBS + ['backgroundLayer.js', 'backgroundLifecycle.js', 'disposables.js']:
            shutil.copy(ROOT / 'lib' / name, extension / 'lib' / name)
        settings = base / 'config/glib-2.0/settings'
        settings.mkdir(parents=True)
        (settings / 'keyfile').write_text(
            f"[org/gnome/shell]\nenabled-extensions=['{uuid}']\ndisable-user-extensions=false\n")
        runtime = base / 'runtime'
        runtime.mkdir(mode=0o700)
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
               'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
               'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
               'GSETTINGS_BACKEND': 'keyfile', 'T08_ASSET': str(asset),
               'T08_STILL': str(still), 'T08_OUTPUT': str(base)}
        proc = subprocess.Popen(['dbus-run-session', '--', 'gnome-shell', '--headless',
                                 '--virtual-monitor=1024x768'], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            output, _ = proc.communicate(timeout=40)
        except subprocess.TimeoutExpired:
            t07.kill_private(t07.shell_pid(runtime), runtime)
            proc.kill()
            output, _ = proc.communicate(timeout=10)
        finally:
            t07.kill_private(t07.shell_pid(runtime), runtime)
        print('\n'.join(line for line in output.splitlines() if
                        'T08_RESULT' in line or 'Gjs-' in line or 'JS ERROR' in line))
        captures = {}
        for path in sorted(base.glob('*.png')):
            pixels = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-vf',
                                     'crop=1:1:512:384,format=rgb24', '-f', 'rawvideo', '-'],
                                    capture_output=True, check=True).stdout
            captures[path.stem] = list(pixels[:3])
            print(json.dumps({'capture': path.name, 'centerRGB': list(pixels[:3])}))
        green = captures.get('settled-source-clone', [])
        passed = (len(green) == 3 and green[1] > 180 and green[0] < 60 and green[2] < 90 and
                  captures.get('before-clone') != green and captures.get('overview') != green and
                  'T08_RESULT {"event":"complete"' in output and '"event":"fail"' not in output)
        return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
