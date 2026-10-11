#!/usr/bin/env python3
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
UUID = 'gink-video-wallpaper@ginkcode.github.io'
PROBE = 't10-probe@ginkcode.github.io'
VOS = ('gpu-next', 'gpu', 'dmabuf-wayland', 'wlshm')
HWDECS = ('vaapi', 'vaapi-copy', 'no')
PHASES = ('visible', 'covered-unpaused', 'covered-paused')
ANCHOR = "argv: buildMpvArgv({mpvPath: 'mpv', socketPath, vo: vo ?? videoOutput(settings)})"
sys.dont_write_bytecode = True


def load_media():
    spec = importlib.util.spec_from_file_location('t10_media', ROOT / 'tests/integration/t10-media.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
    temporary.replace(path)


def aggregate(values):
    values = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]
    return {'count': len(values), 'min': min(values) if values else None,
            'mean': sum(values) / len(values) if values else None, 'max': max(values) if values else None}


def advancement(first, second, duration):
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (first, second, duration)) or duration <= 0:
        return None
    return (second - first) % duration


def harness_sources():
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(
        [ROOT / 'extension.js', *ROOT.glob('lib/*.js'),
         ROOT / 'tests/integration/t10-probe.js', ROOT / 'tests/integration/t10-media.py',
         ROOT / 'tests/integration/run-t10-benchmark.py'])}


def fingerprint(config, manifests):
    # vos/hwdecs/formats choose which rows run; they are not part of the
    # experiment identity, otherwise resuming with a wider matrix would look
    # like a changed experiment.
    stable = {key: value for key, value in config.items()
              if key not in ('vos', 'hwdecs', 'formats')}
    value = {'config': stable, 'assets': manifests, 'sources': harness_sources()}
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


STABLE_CONFIG_KEYS = ('seconds',)


ASSET_IDENTITY_FIELDS = ('name', 'sha256', 'still_sha256')


def asset_identity(entry):
    return {field: entry.get(field) for field in ASSET_IDENTITY_FIELDS}


def verify_resume(saved, expected, manifests, config):
    # A fingerprint difference alone is a migration when the asset identities
    # (content hashes, not temporary paths) and the stable configuration are
    # unchanged: that is a harness edit or a wider matrix scope.
    if saved.get('fingerprint') == expected:
        return None
    saved_assets = saved.get('assets')
    if saved_assets is None:
        # Checkpoints before assets were recorded identified media inside the
        # fingerprint itself; accept them only when that stored identity is intact.
        if not saved.get('fingerprint'):
            raise ValueError('Resume checkpoint has no fingerprint or asset identity')
        saved['assets'] = manifests
    else:
        # Compare per name: a resumed matrix may cover more formats than an
        # earlier partial run recorded, which is row scope, not asset drift.
        saved_ids = {entry['name']: asset_identity(entry) for entry in saved_assets if 'name' in entry}
        current_ids = {entry['name']: asset_identity(entry) for entry in manifests if 'name' in entry}
        if set(saved_ids) - set(current_ids):
            raise ValueError('Resume asset identity changed: regenerate media or keep the original fixture')
        if any(saved_ids[name] != current_ids[name] for name in saved_ids):
            raise ValueError('Resume asset identity changed: regenerate media or keep the original fixture')
    saved_config = saved.get('config', {})
    for key in STABLE_CONFIG_KEYS:
        if saved_config.get(key) != config[key]:
            raise ValueError(f'Resume configuration key {key} changed: not a harness-only migration')
    for row in saved.get('rows', []):
        if 'fingerprint' not in row:
            continue
    migration = 'harness sources changed; assets and configuration identical'
    saved['migration'] = migration
    return migration


def private(pid, runtime):
    try:
        return (Path(f'/proc/{pid}').stat().st_uid == os.getuid() and
                f'XDG_RUNTIME_DIR={runtime}'.encode() in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'))
    except OSError:
        return False


def private_pids(runtime):
    return {int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit() and private(int(p.name), runtime)}


def alive(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z'
    except OSError:
        return False


def kill_private(pid, runtime):
    if runtime.is_symlink() or runtime.stat().st_uid != os.getuid() or runtime.stat().st_mode & 0o077:
        raise RuntimeError('Invalid private runtime ownership/mode')
    try:
        fd = os.pidfd_open(pid)
        try:
            if private(pid, runtime) and alive(pid):
                signal.pidfd_send_signal(fd, signal.SIGKILL)
        finally:
            os.close(fd)
    except ProcessLookupError:
        pass


def gpu():
    result = {}
    for card in sorted(Path('/sys/class/drm').glob('card[0-9]*')):
        for name in ('gpu_busy_percent', 'mem_info_vram_used'):
            path = card / 'device' / name
            try:
                result[str(path)] = int(path.read_text())
            except (OSError, ValueError):
                result[str(path)] = None
    return result


def command(base, *args, timeout=30):
    with (base / 'commands.log').open('ab') as log:
        log.write((repr(args) + '\n').encode())
        return subprocess.run(args, cwd=base, stdout=subprocess.PIPE, stderr=log,
                              timeout=timeout, check=True).stdout


def stage(root, vo, hwdec, media):
    if vo not in VOS or hwdec not in HWDECS:
        raise ValueError('Unsupported experiment arguments')
    for name in ('home', 'data', 'config', 'cache', 'runtime', 'tmp'):
        (root / name).mkdir(mode=0o700, parents=True)
    target = root / 'data/gnome-shell/extensions' / UUID
    target.mkdir(parents=True)
    for name in ('metadata.json', 'extension.js'):
        shutil.copy(ROOT / name, target / name)
    shutil.copytree(ROOT / 'lib', target / 'lib')
    source = (target / 'lib/playerManager.js').read_text()
    if source.count(ANCHOR) != 1:
        raise RuntimeError('Private injection source anchor changed')
    replacement = f"argv: buildMpvArgv({{mpvPath: 'mpv', socketPath, vo: '{vo}', hwdec: '{hwdec}'}})"
    patched = source.replace(ANCHOR, replacement)
    (target / 'lib/playerManager.js').write_text(patched)
    import difflib
    (root / 'staged.patch').write_text(''.join(difflib.unified_diff(
        source.splitlines(True), patched.splitlines(True), 'playerManager.js', 'private/playerManager.js')))
    save(root / 'staged.json', {'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
                              'patchedSha256': hashlib.sha256(patched.encode()).hexdigest()})
    shutil.copytree(ROOT / 'schemas', target / 'schemas', ignore=shutil.ignore_patterns('gschemas.compiled'))
    command(root, 'glib-compile-schemas', '--strict', str(target / 'schemas'))
    probe = target.parent / PROBE
    probe.mkdir()
    save(probe / 'metadata.json', {'uuid': PROBE, 'name': 'T10 probe', 'description': 'Private benchmark', 'shell-version': ['50']})
    shutil.copy(ROOT / 'tests/integration/t10-probe.js', probe / 'extension.js')
    settings = root / 'config/glib-2.0/settings'
    settings.mkdir(parents=True)
    configs = {'Meta-0:MetaVendor:MetaVirtualMonitor:0x00': {'file': media, 'fitMode': None, 'optimize': None}}
    (settings / 'keyfile').write_text(f"[org/gnome/shell]\nenabled-extensions=['{PROBE}']\ndisable-user-extensions=false\n"
                                      f"[org/gnome/shell/extensions/gink-video-wallpaper]\n"
                                      f"monitor-configs='{json.dumps(configs)}'\n")


def classify(events, error=None):
    names = {e.get('event') for e in events}
    fail = next((e for e in events if e.get('event') == 'fail'), None)
    if error:
        return 'watchdog-or-harness-failed'
    if fail:
        message = fail.get('message', '').lower()
        if 'stall' in message or 'advance' in message:
            return 'stalled-playback'
        if 'startup' in message or 'ready' in message:
            return 'unsupported-startup-or-readiness'
        return 'playback-or-readiness-failed'
    if not {'content-ready', 'first-frame-ready', 'complete', 'audit'} <= names:
        return 'incomplete-evidence'
    return 'pending-capture-validation'


def image_pixels(base, path):
    return command(base, 'ffmpeg', '-v', 'error', '-threads', '2', '-i', str(path),
                   '-vf', 'crop=900:650:62:80,scale=90:65,format=rgb24',
                   '-frames:v', '1', '-f', 'rawvideo', '-')


def image_distance(a, b):
    if not a or len(a) != len(b):
        return None
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def nearest_reference_distance(media, root, asset, time_pos, actual, samples=(-1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5)):
    return min((image_distance(actual, image_pixels(root, media.expected_frame(root, asset, (time_pos + dt) % 8)))
                for dt in samples), default=None)


def validate_captures(root, asset, events):
    media = load_media()
    checks = []
    previous = None
    for event in events:
        if event.get('event') != 'capture' or event.get('timePos') is None:
            continue
        if not event.get('name', '').startswith(('preflight-', 'visible-', 'uncovered-')):
            continue
        actual = image_pixels(root, event['path'])
        position = float(event['timePos']) % 8
        fill = nearest_reference_distance(media, root, asset, position, actual)
        # The hidden-window + clone path can render the whole frame stretched
        # instead of the fit-mode crop; match content either way and record which
        # geometry the clone actually displayed.
        stretch = min((image_distance(actual, image_pixels(root, media.stretched_frame(root, asset, (position + dt) % 8)))
                       for dt in (-0.5, -0.25, 0, 0.25, 0.5)), default=None)
        distance = min(fill, stretch, key=lambda value: float('inf') if value is None else value)
        basis = 'fill' if fill is not None and fill <= (stretch if stretch is not None else fill) else 'stretch'
        changed = image_distance(actual, previous) if previous else None
        checks.append({'name': event['name'], 'meanAbsoluteRgbError': distance,
                       'matchBasis': basis, 'fillError': fill, 'stretchError': stretch,
                       'changeFromPrevious': changed,
                       'matches': distance is not None and distance < 40})
        previous = actual
    return {'frames': checks, 'valid': len(checks) >= 2 and all(c['matches'] for c in checks)
            and any(c['changeFromPrevious'] is not None and c['changeFromPrevious'] > 0.5 for c in checks),
            'geometryDeviation': any(c['matchBasis'] == 'stretch' for c in checks)}


def run_row(base, asset, vo, hwdec, seconds):
    key = f"{asset['name']}-{vo}-{hwdec}"
    # Use short row directory names to guarantee runtime socket paths stay well under the 108-byte limit
    root = base / 'r' / str(time.time_ns() % 100000000)
    stage(root, vo, hwdec, asset['path'])
    runtime = root / 'runtime'
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(root / 'home'),
           'XDG_RUNTIME_DIR': str(runtime), 'XDG_DATA_HOME': str(root / 'data'),
           'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache'),
           'XDG_CURRENT_DESKTOP': 'GNOME', 'XDG_SESSION_TYPE': 'wayland',
           'TMPDIR': str(root / 'tmp'), 'GSETTINGS_BACKEND': 'keyfile',
           'T10_OUTPUT': str(root), 'T10_SECONDS': str(seconds)}
    events, metrics, owned, pidstats = [], [], set(), {}
    stop = threading.Event()
    start = time.monotonic()
    error = None
    proc = subprocess.Popen(['dbus-run-session', '--', 'gnome-shell', '--headless',
                             '--virtual-monitor=1024x768'], env=env, cwd=root,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')

    def pump():
        with (root / 'shell.log').open('w') as log:
            for line in proc.stdout:
                log.write(line)
                log.flush()
                if 'T10_RESULT ' in line:
                    try:
                        events.append(json.loads(line.split('T10_RESULT ', 1)[1]))
                    except json.JSONDecodeError:
                        pass

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    previous = {}
    baseline = gpu()
    phase_now = lambda: next((e for e in reversed(events) if e.get('event') == 'phase-start'), {})
    try:
        while proc.poll() is None:
            if time.monotonic() - start > seconds * 3 + 150:
                error = 'Independent wall-clock watchdog expired'
                break
            current = private_pids(runtime)
            owned.update(current)
            for pid in current:
                try:
                    comm = Path(f'/proc/{pid}/comm').read_text().strip()
                    if comm not in ('mpv', 'gnome-shell'):
                        continue
                    if pid not in pidstats:
                        stream = (root / f'pidstat-{pid}.log').open('wb')
                        p = subprocess.Popen(['pidstat', '-u', '-r', '-h', '-p', str(pid), '5'],
                                             env=env, cwd=root, stdout=stream, stderr=subprocess.STDOUT)
                        pidstats[pid] = (p, stream)
                    stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
                    cpu = (int(stat[11]) + int(stat[12])) / os.sysconf('SC_CLK_TCK')
                    now = time.monotonic()
                    old = previous.get(pid)
                    metrics.append({'elapsed': now - start, 'pid': pid, 'comm': comm,
                                    'phase': phase_now().get('phase'),
                                    'cpuPercent': (cpu - old[0]) / (now - old[1]) * 100 if old else None,
                                    'rssKiB': int(stat[21]) * os.sysconf('SC_PAGE_SIZE') / 1024,
                                    'gpuContextual': gpu()})
                    previous[pid] = (cpu, now)
                except (OSError, ValueError):
                    pass
            stop.wait(5)
        if not error:
            proc.wait(timeout=10)
    finally:
        survivors = sorted(pid for pid in owned | private_pids(runtime) if alive(pid) and private(pid, runtime))
        for pid in survivors:
            kill_private(pid, runtime)
        for p, stream in pidstats.values():
            kill_private(p.pid, runtime)
            p.wait(timeout=10)
            stream.close()
        if proc.poll() is None:
            kill_private(proc.pid, runtime)
        proc.wait(timeout=10)
        thread.join(timeout=5)
    result = {'key': key, 'requested': {'vo': vo, 'hwdec': hwdec}, 'asset': asset['name'],
              'directory': str(root), 'secondsPerPhase': seconds, 'events': events, 'metrics': metrics,
              'gpuBaselineContextual': baseline, 'error': error, 'returncode': proc.returncode,
              'survivorsBeforeCleanup': survivors, 'status': classify(events, error)}
    result['aggregate'] = {phase: {comm: {field: aggregate(m[field] for m in metrics
                                                           if m.get('phase') == phase and m['comm'] == comm)
                                          for field in ('cpuPercent', 'rssKiB')}
                                   for comm in ('mpv', 'gnome-shell')} for phase in PHASES}
    samples = [e for e in events if e.get('event') == 'sample']
    result['effective'] = {'vos': sorted({str(e.get('vo')) for e in samples}),
                           'hwdecs': sorted({str(e.get('hwdec')) for e in samples}),
                           'codecs': sorted({str(e.get('videoCodec')) for e in samples})}
    result['decoderFallback'] = hwdec != 'no' and any(e.get('hwdec') in (None, 'no', '') for e in samples)
    result['ipcAggregate'] = {phase: {field: aggregate(e.get(field) for e in samples if e.get('phase') == phase)
                                     for field in ('dropped', 'delayed', 'timePos')}
                              for phase in PHASES}
    if result['status'] == 'pending-capture-validation':
        try:
            result['captureValidation'] = validate_captures(root, asset, events)
            result['status'] = 'viable' if result['captureValidation']['valid'] else 'invalid-clone-rendering'
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            result['status'] = 'capture-validation-failed'
            result['captureError'] = str(exc)
    save(root / 'result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description='Isolated checkpointed T10 VO benchmark; never installs in the real session')
    parser.add_argument('--fixture', type=Path)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--seconds', type=int, default=60)
    parser.add_argument('--formats', default='h264,hevc,vp9,mov,av1,gif,sar,rotation,sdr')
    parser.add_argument('--vos', default=','.join(VOS))
    parser.add_argument('--hwdecs', default=','.join(HWDECS))
    options = parser.parse_args()
    if options.seconds < 5:
        parser.error('At least 5 seconds per phase required')
    if options.resume and not options.fixture:
        parser.error('--resume requires --fixture')
    base = options.fixture.resolve() if options.fixture else Path(tempfile.mkdtemp(prefix='t-', dir='/tmp'))
    if not base.exists():
        base.mkdir(mode=0o700)
    if base.is_symlink() or base.stat().st_uid != os.getuid():
        parser.error('Fixture must be owned, non-symlink directory')
    if any(base.iterdir()) and not (options.resume or list((base / 'media').glob('manifest.json')) == [base / 'media/manifest.json']):
        parser.error('New fixture must be empty, or contain only pre-generated media with --resume')
    print(f'T10 fixture: {base}', flush=True)
    media = load_media()
    manifests = json.loads((base / 'media/manifest.json').read_text()) if options.resume else media.generate(base, options.formats.split(','))
    assets = media.validate_manifest(manifests)
    hdr = json.loads((base / 'media/manifest-hdr.json').read_text()) if options.resume else media.generate(base, ['hdr'])
    hdr_rejected = False
    try:
        media.validate_manifest(hdr)
    except media.MediaError as exc:
        hdr_rejected = 'HDR is unsupported' in str(exc)
        save(base / 'hdr-negative-control.json', {'rejectedByHarness': hdr_rejected,
                                                 'message': str(exc), 'productionRejection': False})
    if not hdr_rejected:
        raise RuntimeError('HDR negative control did not produce actionable harness rejection')
    versions = {tool: command(base, tool, '--version').decode(errors='replace').splitlines()[0]
                for tool in ('gnome-shell', 'mpv', 'gjs', 'setpriv')}
    versions.update({tool: command(base, tool, '-version').decode(errors='replace').splitlines()[0]
                     for tool in ('ffmpeg', 'ffprobe')})
    versions['pidstat'] = command(base, 'pidstat', '-V').decode(errors='replace').splitlines()[0]
    save(base / 'device.json', {'uname': os.uname()._asdict() if hasattr(os.uname(), '_asdict') else list(os.uname()),
                              'gpuContextual': gpu(), 'lspci': command(base, 'lspci', '-nn').decode(errors='replace')})
    config = {'seconds': options.seconds, 'formats': options.formats, 'vos': options.vos,
              'hwdecs': options.hwdecs, 'versions': versions, 'gpu': sorted(gpu())}
    mark = fingerprint(config, manifests)
    checkpoint = base / 'checkpoint.json'
    results = json.loads(checkpoint.read_text()) if options.resume else {'fingerprint': mark, 'config': config, 'rows': []}
    migration = verify_resume(results, mark, manifests, config)
    if migration:
        print(f'Resume migration: {migration}', flush=True)
    save(checkpoint, results)
    for asset in assets:
        for vo in options.vos.split(','):
            for hwdec in options.hwdecs.split(','):
                key = f"{asset['name']}-{vo}-{hwdec}"
                if any(row['key'] == key for row in results['rows']):
                    continue
                print(f'Running {key}', flush=True)
                row = run_row(base, asset, vo, hwdec, options.seconds)
                results['rows'].append(row)
                save(checkpoint, results)
                print(f"{key}: {row['status']}", flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
