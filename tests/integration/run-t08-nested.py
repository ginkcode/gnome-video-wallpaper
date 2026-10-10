#!/usr/bin/env python3
import argparse
import json
import math
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
spec = spec_from_file_location('t07_runner', ROOT / 'tests/integration/run-t07-nested.py')
t07 = module_from_spec(spec)
spec.loader.exec_module(t07)
UUID = 't08-fixture@ginkcode.github.io'


def command(base, *args, timeout=30):
    with (base / 'commands.log').open('ab') as log:
        log.write((repr(args) + '\n').encode())
        return subprocess.run(args, cwd=base, stdout=subprocess.PIPE, stderr=log,
                              check=True, timeout=timeout).stdout


def events_from_log(path):
    events = []
    for line in path.read_text(errors='replace').splitlines():
        if 'T08_RESULT ' not in line:
            continue
        try:
            event = json.loads(line.split('T08_RESULT ', 1)[1])
            if isinstance(event, dict):
                events.append(event)
        except json.JSONDecodeError:
            pass
    return events


def stop_process(proc):
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=3)


def stop_session(proc, runtime, pid_path, events):
    pids = {int(event['pid']) for event in events
            if event.get('event') == 'spawn' and str(event.get('pid', '')).isdigit()}
    shells = {int(event['shellPid']) for event in events
              if event.get('event') == 'fixture' and str(event.get('shellPid', '')).isdigit()}
    if pid_path.exists():
        value = pid_path.read_text().strip()
        if value.isdigit():
            shells.add(int(value))
    shells = {pid for pid in shells if pid > 1}
    pids = {pid for pid in pids if pid > 1}
    services = set()
    for name in ('pipewire', 'wireplumber'):
        path = pid_path.parent / f'{name}.pid'
        if path.exists() and path.read_text().strip().isdigit():
            services.add(int(path.read_text().strip()))
    controls = {int(event['pid']) for event in events
                if event.get('event') == 'control-spawn' and str(event.get('pid', '')).isdigit()}
    for pid in sorted(shells | pids | services | controls):
        t07.kill_private(pid, runtime)
    # The process group was created for this fixture, not discovered from other runs.
    if proc is not None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                pass
            if sig == signal.SIGTERM:
                time.sleep(0.2)
        stop_process(proc)
    return {'shellPids': sorted(shells), 'playerPids': sorted(pids)}


def stage_consumers(base):
    roots = [Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))),
             *map(Path, os.environ.get('XDG_DATA_DIRS', '/usr/local/share:/usr/share').split(':'))]
    shell_major = command(base, 'gnome-shell', '--version').decode().split()[-1].split('.')[0]
    staged, reports = [], []
    for consumer, uuids in [('dock', ['dash-to-dock@micxgx.gmail.com', 'ubuntu-dock@ubuntu.com']),
                            ('ding', ['ding@rastersoft.com'])]:
        found = False
        for uuid in uuids:
            for root in roots:
                source = root / 'gnome-shell/extensions' / uuid
                try:
                    metadata = json.loads((source / 'metadata.json').read_text())
                except (OSError, json.JSONDecodeError):
                    continue
                if (metadata.get('uuid') != uuid or
                        shell_major not in map(str, metadata.get('shell-version', []))):
                    continue
                target = base / 'data/gnome-shell/extensions' / uuid
                shutil.copytree(source, target, symlinks=False)
                staged.append(uuid)
                reports.append({'consumer': consumer, 'status': 'staged', 'source': str(source),
                                'uuid': uuid, 'shellVersion': shell_major})
                found = True
                break
            if found:
                break
        if not found:
            reports.append({'consumer': consumer, 'status': 'blocked',
                            'reason': 'No compatible installed extension; no download attempted'})
    return staged, reports


def green(rgb):
    return len(rgb) == 3 and rgb[1] > 180 and rgb[0] < 60 and rgb[2] < 90


def analyse_recording(base, events):
    result = {'status': 'blocked', 'reason': 'Missing recording/timing markers',
              'targetFps': 60, 'maximumAllowedGapSec': 0.020}
    started = next((e for e in events if e.get('event') == 'recording-started'), None)
    reveal = next((e for e in events if e.get('event') == 'clone-reveal'), None)
    stopped = next((e for e in events if e.get('event') == 'recording-stopped'), None)
    if not all((started, reveal, stopped)):
        return result
    filename = started.get('filename')
    if not filename:
        return result
    path = Path(filename).resolve()
    if not path.is_relative_to(base.resolve()) or not path.is_file():
        result['reason'] = 'Recording is absent or outside fixture directory'
        return result
    try:
        probe_bytes = command(base, 'ffprobe', '-v', 'error', '-select_streams', 'v:0',
                              '-show_frames', '-show_streams', '-show_entries',
                              'frame=best_effort_timestamp_time,pkt_duration_time,duration_time:'
                              'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,time_base',
                              '-of', 'json', str(path))
        (base / 'map-flash-ffprobe.json').write_bytes(probe_bytes)
        probe = json.loads(probe_bytes)
        timestamps = [float(frame['best_effort_timestamp_time']) for frame in probe.get('frames', [])]
        if len(timestamps) < 2 or not all(math.isfinite(t) for t in timestamps):
            raise ValueError('Insufficient native frame timestamps')
        gaps = [b - a for a, b in zip(timestamps, timestamps[1:])]
        if min(gaps) <= 0:
            raise ValueError('Native timestamps are not strictly increasing')
        start_us, reveal_us, stop_us = (float(e['monotonicUs']) for e in (started, reveal, stopped))
        if not start_us < reveal_us < stop_us:
            raise ValueError('Recording/reveal monotonic markers are out of order')
        reveal_sec = (reveal_us - start_us) / 1e6
        stop_sec = (stop_us - start_us) / 1e6
        effective_fps = (len(timestamps) - 1) / (timestamps[-1] - timestamps[0])
        result.update({'recording': str(path), 'streams': probe.get('streams', []),
                       'nativeFrames': len(timestamps), 'firstPtsSec': timestamps[0],
                       'lastPtsSec': timestamps[-1], 'effectiveFps': effective_fps,
                       'minGapSec': min(gaps), 'maxGapSec': max(gaps),
                       'revealOffsetSec': reveal_sec, 'stopOffsetSec': stop_sec,
                       'clockAlignment': 'unverified: screencast reply monotonic time is not '
                                         'a measured first-PTS origin'})
        # No fps filter or output rate: one RGB sample image per native decoded frame.
        sample_path = base / 'map-flash-native.rgb'
        with sample_path.open('wb') as samples, (base / 'commands.log').open('ab') as log:
            subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0',
                            '-vf', 'scale=64:48,format=rgb24', '-fps_mode', 'passthrough',
                            '-f', 'rawvideo', '-'], cwd=base, stdout=samples, stderr=log,
                           timeout=30, check=True)
        pixels = sample_path.read_bytes()
        frame_size = 64 * 48 * 3
        if len(pixels) != len(timestamps) * frame_size:
            raise ValueError('Native decoded frame count differs from ffprobe')
        guard = max(gaps) + 1 / 60
        samples = []
        for index, pts in enumerate(timestamps):
            image = pixels[index * frame_size:(index + 1) * frame_size]
            count = sum(green(image[offset:offset + 3]) for offset in range(0, frame_size, 3))
            samples.append({'index': index, 'ptsSec': pts, 'greenFraction': count / (64 * 48),
                            'centerRGB': list(image[(24 * 64 + 32) * 3:(24 * 64 + 32) * 3 + 3])})
        (base / 'map-flash-native-samples.json').write_text(json.dumps(samples, indent=2))
        estimated_before = [sample for sample in samples if sample['ptsSec'] < reveal_sec - guard]
        result.update({'boundaryGuardSec': guard, 'downscale': '64x48 diagnostic only',
                       'estimatedPreRevealFrames': len(estimated_before),
                       'estimatedPreRevealGreenFrames': [sample for sample in estimated_before
                                                        if sample['greenFraction'] >= 0.01],
                       'greenPixelPolicy': 'Unsynchronized, downscaled diagnostic; cannot prove '
                                           'absence or timing of a raw flash'})
        if max(gaps) > 0.020 or effective_fps < 59:
            result['reason'] = 'Native capture cadence inadequate for 60 fps no-map-flash verification'
        else:
            result['reason'] = ('Cadence measured, but screencast reply time is not synchronized to '
                                'first PTS and downscaled sampling cannot prove no raw flash')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        result.update(status='blocked', reason=str(error))
    return result


def run(base):
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp'):
        (base / name).mkdir(mode=0o700)
    asset = base / 'selected.mp4'
    command(base, 'ffmpeg', '-y', '-f', 'lavfi', '-i',
            'color=c=0x22cc44:size=320x240:rate=60:duration=2',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(asset))
    still = base / 'selected.png'
    command(base, 'ffmpeg', '-y', '-i', str(asset), '-frames:v', '1', str(still))
    extension = base / 'data/gnome-shell/extensions' / UUID
    (extension / 'lib').mkdir(parents=True)
    (extension / 'metadata.json').write_text(json.dumps({
        'uuid': UUID, 'name': 'T08 fixture', 'description': 'Private feasibility verification',
        'shell-version': ['50']}))
    for source, target in [('t08-extension.js', 'extension.js'), ('t08-capture.js', 't08-capture.js'),
                           ('t08-consumers.js', 't08-consumers.js')]:
        shutil.copy(ROOT / 'tests/integration' / source, extension / target)
    for name in t07.LIBS + ['backgroundLayer.js', 'backgroundLifecycle.js', 'disposables.js']:
        shutil.copy(ROOT / 'lib' / name, extension / 'lib' / name)
    staged, consumer_staging = stage_consumers(base)
    desktop = base / 'home/Desktop'
    desktop.mkdir()
    fixture = 't08-consumer-fixture.txt'
    (desktop / fixture).write_text('Private T08 desktop click fixture\n')
    (base / 'config/user-dirs.dirs').write_text(f'XDG_DESKTOP_DIR="{desktop}"\n')
    settings = base / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    (settings / 'keyfile').write_text(
        f"[org/gnome/shell]\nenabled-extensions={repr(staged + [UUID])}\ndisable-user-extensions=false\n"
        '[org/gnome/desktop/interface]\ntoolkit-accessibility=true\n'
        '[org/gnome/shell/extensions/dash-to-dock]\nshow-running=true\n'
        '[org/gnome/shell/extensions/ding]\nshow-home=false\nshow-trash=false\n'
        'show-volumes=false\nshow-network-volumes=false\n')
    runtime = base / 'runtime'
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(base / 'home'),
           'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(base / 'data'),
           'XDG_DATA_DIRS': '/usr/local/share:/usr/share',
           'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland',
           'XDG_CONFIG_HOME': str(base / 'config'), 'XDG_CACHE_HOME': str(base / 'cache'),
           'TMPDIR': str(base / 'tmp'), 'GSETTINGS_BACKEND': 'keyfile', 'GTK_A11Y': 'atspi',
           'T08_PRIVATE_NESTED': '1', 'T08_DESKTOP_FIXTURE': fixture,
           'T08_ASSET': str(asset), 'T08_STILL': str(still), 'T08_OUTPUT': str(base)}
    log_path, pid_path = base / 'shell.log', base / 'shell.pid'
    proc = None
    error = None
    cleanup = {}
    wrapper = (
        'printf "%s\\n" "$$" > "$1"\n'
        'pipewire > "$2/pipewire.log" 2>&1 &\nprintf "%s\\n" "$!" > "$2/pipewire.pid"\n'
        'wireplumber > "$2/wireplumber.log" 2>&1 &\nprintf "%s\\n" "$!" > "$2/wireplumber.pid"\n'
        'sleep 1\nexec gnome-shell --headless --virtual-monitor=1024x768\n')
    with log_path.open('wb') as log:
        try:
            proc = subprocess.Popen([
                'dbus-run-session', '--', '/bin/sh', '-c', wrapper, 't08-shell',
                str(pid_path), str(base)], env=env, cwd=base, start_new_session=True,
                stdout=log, stderr=subprocess.STDOUT)
            proc.wait(timeout=90)
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            error = str(exc)
        finally:
            cleanup = stop_session(proc, runtime, pid_path, events_from_log(log_path))
    output = log_path.read_text(errors='replace')
    events = events_from_log(log_path)
    for line in output.splitlines():
        if any(marker in line for marker in ('T08_RESULT', 'Gjs-', 'JS ERROR')):
            print(line)
    captures = {}
    source_pixels = command(base, 'ffmpeg', '-v', 'error', '-i', str(still), '-vf',
                            'crop=1:1:160:120,format=rgb24', '-f', 'rawvideo', '-')
    captures['selected-source-still'] = list(source_pixels[:3])
    for path in sorted(base.glob('*.png')):
        if path == still:
            continue
        pixels = command(base, 'ffmpeg', '-v', 'error', '-i', str(path), '-vf',
                         'crop=1:1:512:384,format=rgb24', '-f', 'rawvideo', '-')
        captures[path.stem] = list(pixels[:3])
    media = analyse_recording(base, events)
    consumers = next((event.get('reports', []) for event in events
                      if event.get('event') == 'consumers'), [])
    consumer_names = {'overview', 'dock', 'altTab-applications', 'altTab-windows', 'ding'}
    consumers_verified = (consumer_names <= {r.get('consumer') for r in consumers} and
                          all(r.get('status') == 'verified' for r in consumers))
    selected = captures.get('settled-source-clone', [])
    source_still = captures['selected-source-still']
    def matches_still(rgb, tolerance=6):
        return (len(rgb) == 3 and
                max(abs(a - b) for a, b in zip(rgb, source_still)) <= tolerance)

    handoff_held = next((e for e in events if e.get('event') == 'handoff-held'), {})
    handoff_complete = next((e for e in events if e.get('event') == 'handoff-complete'), {})
    handoff_checks_passed = (
        handoff_held.get('ordering') is True and
        handoff_held.get('isLoaded') is False and
        handoff_complete.get('loaded') is True and
        matches_still(captures.get('layer-static', [])) and
        matches_still(captures.get('handoff-transition', [])) and
        matches_still(captures.get('handoff-loaded', [])) and
        all(matches_still(captures.get(f'handoff-delay-{i}', [])) for i in range(5)))

    visual = (green(selected) and not green(captures.get('before-clone', [])) and
              not green(captures.get('overview', [])) and
              green(captures.get('layer-video', [])) and
              handoff_checks_passed)
    clone_state = next((e for e in events if e.get('event') == 'clone'), {})
    readiness = next((e for e in events if e.get('event') == 'readiness'), {})
    unfocused = clone_state.get('focused') is False and readiness.get('focused') is False
    failed = (error is not None or proc is None or proc.returncode != 0 or not visual or
              not unfocused or
              any(e.get('event') in ('fail', 'consumers-failed') for e in events) or
              not any(e.get('event') == 'complete' for e in events) or
              media['status'] == 'failed')
    status = 'failed' if failed else ('verified' if media['status'] == 'verified' and
                                    consumers_verified else 'blocked')
    result = {'status': status, 'fixture': str(base), 'error': error,
              'shellReturncode': proc.returncode if proc else None, 'cleanup': cleanup,
              'consumerStaging': consumer_staging, 'consumers': consumers,
              'captures': captures, 'visualChecksPassed': visual, 'unfocused': unfocused,
              'handoffChecksPassed': handoff_checks_passed, 'mapFlash': media,
              'events': events}
    (base / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return 0 if status == 'verified' else (2 if status == 'blocked' else 1)


def main():
    parser = argparse.ArgumentParser(description='Private headless GNOME Shell T08 verification')
    parser.add_argument('--keep', action='store_true', help='Retain fixture directory and all evidence')
    options = parser.parse_args()
    base = Path(tempfile.mkdtemp(prefix='t08-', dir='/tmp'))
    print(f'T08 fixture: {base}', flush=True)
    try:
        return run(base)
    finally:
        if options.keep:
            print(f'Retained T08 evidence: {base}', flush=True)
        else:
            shutil.rmtree(base)


if __name__ == '__main__':
    raise SystemExit(main())
