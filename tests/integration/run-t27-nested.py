#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import re
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
t07 = t09.t07
UUID = 'gink-video-wallpaper@ginkcode.github.io'
PROBE = 't27-probe@ginkcode.github.io'
HANABI = 'hanabi-extension@jeffshee.github.io'
USER_EXTENSIONS = Path.home() / '.local/share/gnome-shell/extensions'
USER_SCHEMAS = Path.home() / '.local/share/glib-2.0/schemas'
SYSTEM_EXTENSIONS = Path('/usr/share/gnome-shell/extensions')
DOCK = 'dash-to-dock@micxgx.gmail.com'
BLUR = 'blur-my-shell@aunetx'
CAFFEINE = 'caffeine@patapon.info'
INDICATOR = 'appindicatorsupport@rgcjonas.gmail.com'
MONITOR = 'system-monitor-panel@naimur'
KIMPANEL = 'kimpanel@kde.org'
APPS_MENU = 'apps-menu@gnome-shell-extensions.gcampax.github.com'
REMOTE = 'allowlockedremotedesktop@kamens.us'
DEVICE = [DOCK, CAFFEINE, KIMPANEL, INDICATOR, APPS_MENU, REMOTE, MONITOR, BLUR]
UBUNTU = ['ubuntu-dock@ubuntu.com', 'tiling-assistant@ubuntu.com', 'web-search-provider@ubuntu.com',
          'ubuntu-appindicators@ubuntu.com', 'snapd-search-provider@canonical.com',
          'snapd-prompting@canonical.com', 'ding@rastersoft.com']
DEVICE_SETTINGS = '''[org/gnome/shell/extensions/dash-to-dock]
apply-custom-theme=true
background-opacity=0.8
click-action='skip'
custom-theme-shrink=true
dash-max-icon-size=32
disable-overview-on-startup=true
dock-position='BOTTOM'
height-fraction=0.9
intellihide-mode='FOCUS_APPLICATION_WINDOWS'
multi-monitor=true
[org/gnome/shell/extensions/blur-my-shell/dash-to-dock]
blur=true
brightness=0.6
sigma=30
static-blur=true
style-dash-to-dock=0
[org/gnome/shell/extensions/blur-my-shell/panel]
brightness=0.6
corner-radius=0
sigma=30
'''
AGGRESSIVE_BLUR = '''[org/gnome/shell/extensions/blur-my-shell/applications]
blur=true
enable-all=true
[org/gnome/shell/extensions/blur-my-shell/panel]
static-blur=false
[org/gnome/shell/extensions/dash-to-dock]
intellihide-mode='ALL_WINDOWS'
disable-overview-on-startup=true
'''
SCENARIOS = {
    'device-last': {'mode': 'ubuntu', 'enabled': DEVICE + [UUID], 'disabled': UBUNTU + [HANABI],
                    'settings': DEVICE_SETTINGS, 'lock': True, 'idleControl': True, 'caffeineUser': True,
                    'cycleOurs': 3, 'toggleOthers': DEVICE},
    'device-first': {'mode': 'ubuntu', 'enabled': [UUID] + DEVICE, 'disabled': UBUNTU + [HANABI],
                     'settings': DEVICE_SETTINGS, 'lock': True, 'cycleOurs': 3, 'toggleOthers': [DOCK, BLUR]},
    'ubuntu-system': {'mode': 'ubuntu', 'enabled': [UUID], 'disabled': [], 'cycleOurs': 2,
                      'toggleOthers': ['ubuntu-dock@ubuntu.com', 'ding@rastersoft.com',
                                       'tiling-assistant@ubuntu.com', 'ubuntu-appindicators@ubuntu.com']},
    'blur-aggressive': {'mode': 'user', 'enabled': [BLUR, DOCK, UUID], 'disabled': [],
                        'settings': AGGRESSIVE_BLUR, 'cycleOurs': 1, 'toggleOthers': [BLUR, DOCK]},
    'hanabi': {'mode': 'user', 'enabled': [UUID, HANABI], 'disabled': [], 'hanabi': True, 'cycleOurs': 1},
}
SCRIPT = '''
gjs -m "$5/tests/integration/t27-services.js" >"$1/services.log" 2>&1 &
for _ in $(seq 50); do grep -q ready "$1/services.log" && break; sleep 0.1; done
gnome-shell --headless --mode="$6" --virtual-monitor=1920x1080 >"$1/shell.log" 2>&1 &
shell=$!
for _ in $(seq 150); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
sleep 3
timeout 900 gjs -m "$5/tests/integration/t27-driver.js" "$2" "$3" "$4" "$5"
kill "$shell"
wait "$shell"
'''
JS_PATH = re.compile(r'/extensions/([^/]+)/')


def setup(base, scenario, debug=False):
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp', 'captures'):
        (base / name).mkdir(mode=0o700)
    (base / 'home/Desktop').mkdir()
    extensions = base / 'data/gnome-shell/extensions'
    target = extensions / UUID
    target.mkdir(parents=True)
    for name in ('metadata.json', 'extension.js', 'prefs.js'):
        shutil.copy(ROOT / name, target / name)
    shutil.copytree(ROOT / 'lib', target / 'lib')
    shutil.copytree(ROOT / 'prefs', target / 'prefs')
    (target / 'schemas').mkdir()
    shutil.copy(next((ROOT / 'schemas').glob('*.gschema.xml')), target / 'schemas')
    t09.command(base, 'glib-compile-schemas', '--strict', str(target / 'schemas'))
    copied = []
    for uuid in scenario['enabled'] + scenario['disabled']:
        source = USER_EXTENSIONS / uuid
        if uuid != UUID and source.is_dir():
            shutil.copytree(source, extensions / uuid, symlinks=True)
            copied.append(uuid)
    schemas = base / 'data/glib-2.0/schemas'
    schemas.mkdir(parents=True)
    hanabi_schema = USER_SCHEMAS / 'io.github.jeffshee.hanabi-extension.gschema.xml'
    if HANABI in copied and hanabi_schema.exists():
        shutil.copy(hanabi_schema, schemas)
        t09.command(base, 'glib-compile-schemas', str(schemas))
    probe = extensions / PROBE
    probe.mkdir()
    (probe / 'metadata.json').write_text(json.dumps({
        'uuid': PROBE, 'name': 'T27 probe', 'description': 'Private compatibility verification',
        'shell-version': ['50'], 'session-modes': ['user', 'unlock-dialog']}))
    shutil.copy(ROOT / 'tests/integration/t27-probe.js', probe / 'extension.js')
    asset = base / 'red.mp4'
    t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=30:duration=4',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', str(asset))
    original = base / 'original.png'
    t09.command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=magenta:size=64x64', '-frames:v', '1',
                str(original))
    enabled = ', '.join(f"'{uuid}'" for uuid in [PROBE] + scenario['enabled'])
    disabled = ', '.join(f"'{uuid}'" for uuid in scenario['disabled'])
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions=[{enabled}]\ndisabled-extensions=[{disabled}]\n"
        "disable-user-extensions=false\n"
        f"[org/gnome/desktop/background]\npicture-uri='file://{original}'\n"
        f"picture-uri-dark='file://{original}'\npicture-options='zoom'\n"
        "[org/gnome/shell/extensions/gink-video-wallpaper]\nstartup-delay-ms=uint32 0\n" +
        ("debug-logging=true\n" if debug else "") +
        t09.monitor_configs(asset) +
        scenario.get('settings', ''))
    return asset, copied


def private_processes(runtime):
    found = []
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit() and t07.private(int(entry.name), runtime) and t07.state(int(entry.name)) not in (None, 'Z'):
            try:
                found.append((int(entry.name), (entry / 'comm').read_text().strip()))
            except OSError:
                pass
    return found


def js_errors(log):
    blocks = []
    lines = log.splitlines()
    for index, line in enumerate(lines):
        if 'JS ERROR' in line or 'JS WARNING' in line or 'Gjs-CRITICAL' in line or 'Extension ' in line and 'error' in line.lower():
            stack = [line]
            for follow in lines[index + 1:index + 30]:
                if '@' in follow and ('.js' in follow or 'resource://' in follow):
                    stack.append(follow)
                elif follow.strip() == '':
                    continue
                else:
                    break
            owners = sorted({m.group(1) for s in stack for m in JS_PATH.finditer(s)})
            blocks.append({'owners': owners, 'text': '\n'.join(stack)[:1500]})
    return blocks


def run_scenario(name, scenario, options):
    base = Path(tempfile.mkdtemp(prefix=f't27-{name}-', dir='/tmp'))
    try:
        asset, copied = setup(base, scenario, options.debug)
        runtime = base / 'runtime'
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
               'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
               'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
               'XDG_CURRENT_DESKTOP': 'ubuntu:GNOME' if scenario['mode'] == 'ubuntu' else 'GNOME',
               'XDG_SESSION_TYPE': 'wayland', 'TMPDIR': str(base / 'tmp'), 'GSETTINGS_BACKEND': 'keyfile'}
        if options.debug:
            env['G_MESSAGES_DEBUG'] = 'GNOME Shell Gjs-Console'
        driver = {'name': name, **{k: v for k, v in scenario.items() if k not in ('settings',)}}
        proc = subprocess.Popen(['dbus-run-session', '--', 'bash', '-c', SCRIPT, 'run', str(base),
                                 json.dumps(driver), str(asset), str(base / 'captures'), str(ROOT), scenario['mode']],
                                env=env, cwd=base, start_new_session=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors='replace')
        try:
            out, _ = proc.communicate(timeout=1000)
        except subprocess.TimeoutExpired:
            out = ''
        finally:
            time.sleep(1)
            players = sorted(t09.players(runtime))
            leftovers = private_processes(runtime)
            for pid, _ in leftovers:
                t07.kill_private(pid, runtime)
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(proc.pid, sig)
                except ProcessLookupError:
                    pass
        events = {}
        for line in out.splitlines():
            if 'T27_RESULT ' in line:
                event = json.loads(line.split('T27_RESULT ', 1)[1])
                events.setdefault(event['event'], []).append(event)
        log = (base / 'shell.log').read_text(errors='replace') if (base / 'shell.log').exists() else ''
        result = evaluate(name, scenario, events, log, players, leftovers, copied)
        result['driverOutput'] = [line for line in out.splitlines() if 'T27_RESULT' not in line][-40:]
        (base / 'result.json').write_text(json.dumps({'result': result, 'events': events}, indent=1))
        if options.keep:
            result['fixture'] = str(base)
        return result
    finally:
        if not options.keep:
            shutil.rmtree(base)


def evaluate(name, scenario, events, log, players, leftovers, copied):
    steps = events.get('step', [])
    checks = {}
    check_names = ['oursActive', 'onePlayer', 'playing', 'stopScreensaverNo', 'cloneRenders', 'notRunningApp',
                   'notInDock', 'windowHidden', 'noStaleWindows']
    for key in check_names:
        checks[key] = bool(steps) and all(step['checks'][key] for step in steps)
    start = (events.get('start') or [{}])[0]
    checks['started'] = bool(start.get('settled', {}).get('ok'))
    checks['noDriverError'] = 'error' not in events
    final = (events.get('final') or [{}])[0]
    checks['disableCleans'] = bool(final.get('stopped')) and not final.get('players') and \
        not final.get('sockets') and final.get('backgroundClones') == 0
    checks['noSurvivors'] = not players
    cycles = events.get('cycle', [])
    checks['cycles'] = len(cycles) == scenario.get('cycleOurs', 0) and \
        all(c['stopped'] and c['resumed']['ok'] for c in cycles)
    toggles = events.get('toggleOther', [])
    checks['othersToggle'] = len(toggles) == len(scenario.get('toggleOthers', [])) and \
        all(t['resumed']['ok'] for t in toggles)
    transient = [e for e in final.get('events', []) if e['kind'] in ('dock-icon', 'app-state')]
    checks['noTransientDockOrApp'] = not transient
    idle = (events.get('idle') or [{}])[0]
    our_pids = set(idle.get('ourPids', []))
    our_inhibits = [c for c in idle.get('calls', []) if c['method'] == 'Inhibit' and
                    (c['pid'] in our_pids or any('gink' in str(a) for a in c['args']))]
    checks['noIdleInhibitFromOurs'] = idle.get('inhibitedBefore') is False and not our_inhibits and \
        not idle.get('mprisNames')
    if scenario.get('idleControl'):
        checks['idleControlDetected'] = bool(idle.get('controlInhibited')) and bool(idle.get('controlReleased'))
    if scenario.get('caffeineUser'):
        caffeine = (events.get('caffeine') or [{}])[0]
        checks['caffeineIndependent'] = bool(caffeine.get('inhibitorsWhileOn')) and \
            bool(caffeine.get('playingWhileOn')) and not caffeine.get('after')
    if scenario.get('lock'):
        locked = (events.get('locked') or [{}])[0]
        unlocked = (events.get('unlocked') or [{}])[0]
        remote = [e for e in locked.get('extensions', []) if e['uuid'] == REMOTE]
        checks['lockStopsAndUnlockResumes'] = bool(locked.get('stopped')) and bool(locked.get('locked')) and \
            bool(unlocked.get('resumed', {}).get('ok'))
        if remote:
            checks['remoteDesktopStaysActiveWhileLocked'] = remote[0]['state'] == 1
    if scenario.get('hanabi'):
        hanabi = (events.get('hanabi') or [{}])[0]
        prefs = hanabi.get('prefs', {})
        warnings = [line for line in log.splitlines() if '[gink-vw] [compat]' in line and 'Hanabi' in line]
        checks['hanabiWarningLogged'] = len(warnings) >= 1
        checks['hanabiPrefsDetects'] = bool(prefs.get('initial', {}).get('active')) and \
            bool(prefs.get('initial', {}).get('revealed'))
        checks['hanabiPrefsLive'] = bool(prefs.get('disabled', {}).get('cleared')) and \
            bool(prefs.get('reenabled', {}).get('shown'))
        checks['hanabiWarningOnReenable'] = len(warnings) >= 2
        checks['hanabiWatcherTracks'] = hanabi.get('watcher') is True and \
            (events.get('hanabiOff') or [{}])[0].get('watcher') is False
    blocks = js_errors(log)
    ours_errors = [b for b in blocks if UUID in b['owners']]
    ours_errors += [{'owners': [UUID], 'text': line} for line in log.splitlines()
                    if '[gink-vw]' in line and ('CRITICAL' in line or 'ERROR' in line or 'failed' in line)]
    checks['noErrorsFromOurs'] = not ours_errors
    states = {}
    for step in steps:
        for ext in step['extensions']:
            states[ext['uuid']] = {'state': ext['state'], 'error': ext['error']}
    first = steps[0] if steps else {}
    info = {'docks': [{k: d[k] for k in ('dockState', 'overlap', 'visible', 'icons', 'ourIcons')}
                      for d in first.get('docks', [])],
            'monitors': first.get('monitors'), 'pixels': first.get('pixels', {}) and first['pixels'].get('hues'),
            'window': first.get('windows'), 'panel': first.get('panel'),
            'stepDocks': {s['label']: [(d['dockState'], d['overlap']) for d in s['docks']] for s in steps},
            'stepPixels': {s['label']: s['pixels'] and s['pixels']['hues'] for s in steps},
            'idleCalls': [{k: c[k] for k in ('iface', 'method', 'args', 'pid')} for c in idle.get('calls', [])],
            'shellPid': idle.get('shellPid'), 'ourPids': idle.get('ourPids'),
            'controlLog': idle.get('controlLog'), 'caffeine': events.get('caffeine'),
            'hanabi': events.get('hanabi'), 'locked': [{k: v for k, v in e.items() if k != 'extensions'}
                                                      for e in events.get('locked', [])],
            'cycleDocks': [{'without': [(d['dockState'], d['overlap']) for d in c.get('docksWithoutOurs', [])],
                            'with': [(d['dockState'], d['overlap']) for d in c.get('docksWithOurs', [])]}
                           for c in cycles],
            'transient': transient[:10], 'toggles': [{k: t[k] for k in ('uuid', 'oursRestarted', 'order')}
                                                    for t in toggles],
            'otherErrors': [b for b in blocks if UUID not in b['owners']][:25],
            'oursErrors': ours_errors[:10], 'extensionStates': states, 'copied': copied,
            'leftovers': leftovers, 'driverError': events.get('error')}
    return {'name': name, 'checks': checks, 'info': info}


def main():
    parser = argparse.ArgumentParser(description='Private headless T27 extension compatibility matrix')
    parser.add_argument('--keep', action='store_true', help='retain fixture directories and captures')
    parser.add_argument('--debug', action='store_true', help='enable gink-video-wallpaper debug logging')
    parser.add_argument('--only', default=','.join(SCENARIOS), help='comma separated scenario names')
    options = parser.parse_args()
    results = []
    for name in options.only.split(','):
        print(f'== {name}', flush=True)
        result = run_scenario(name, SCENARIOS[name], options)
        results.append(result)
        print(json.dumps(result, indent=1), flush=True)
    print('== summary')
    for result in results:
        failed = [k for k, v in result['checks'].items() if not v]
        print(f"{result['name']}: {'ok' if not failed else 'FAILED ' + ','.join(failed)}")
    verified = all(all(r['checks'].values()) for r in results)
    print('verified' if verified else 'failed')
    return 0 if verified else 1


if __name__ == '__main__':
    raise SystemExit(main())
