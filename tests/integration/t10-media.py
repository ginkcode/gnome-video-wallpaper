#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import resource
import shlex
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True

DURATION = 8
TIMEOUT = 240
NAMES = ('h264', 'hevc', 'vp9', 'mov', 'av1', 'gif', 'sar', 'rotation', 'sdr')
SPECS = {
    'h264': ('mp4', 'libx264', 'h264', 1920, 1080),
    'hevc': ('mkv', 'libx265', 'hevc', 3840, 2160),
    'vp9': ('webm', 'libvpx-vp9', 'vp9', 1920, 1080),
    'mov': ('mov', 'libx264', 'h264', 1920, 1080),
    'av1': ('mkv', None, 'av1', 1920, 1080),
    'gif': ('gif', 'gif', 'gif', 1920, 1080),
    'sar': ('mp4', 'libx264', 'h264', 1920, 1080),
    'rotation': ('mp4', 'libx264', 'h264', 1920, 1080),
    'sdr': ('mp4', 'libx264', 'h264', 1920, 1080),
    'hdr': ('mkv', 'libx265', 'hevc', 1920, 1080),
}


class MediaError(ValueError):
    pass


def _limits():
    resource.setrlimit(resource.RLIMIT_AS, (4 * 1024**3, 4 * 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024**2, 512 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT, TIMEOUT + 1))


def _run(base, argv, commands):
    argv = [str(arg) for arg in argv]
    commands.append(argv)
    with (base / 'commands.log').open('ab') as log:
        log.write((shlex.join(argv) + '\n').encode())
        log.flush()
        result = subprocess.run(argv, cwd=base, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=log, timeout=TIMEOUT,
                                preexec_fn=_limits, env={'PATH': '/usr/bin:/bin', 'LANG': 'C',
                                                       'OMP_NUM_THREADS': '2'})
    if result.returncode:
        raise MediaError(f'{argv[0]} exited {result.returncode}; see {base / "commands.log"}')
    return result.stdout


def _ffmpeg():
    return ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2']


def _probe(base, path, commands):
    return json.loads(_run(base, ['ffprobe', '-v', 'error', '-threads', '2',
                                 '-show_streams', '-show_format', '-of', 'json', path], commands))


def _sha256(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def _video(probe):
    streams = probe.get('streams', []) if isinstance(probe, dict) else []
    return next((stream for stream in streams if stream.get('codec_type') == 'video'), {})


def _is_hdr(stream):
    return (stream.get('color_transfer') in ('smpte2084', 'arib-std-b67') or
            any('mastering display' in str(item.get('side_data_type', '')).lower() or
                'content light' in str(item.get('side_data_type', '')).lower()
                for item in stream.get('side_data_list', [])))


def _encoder_options(encoder):
    if encoder == 'libx264':
        return ['-preset', 'ultrafast', '-crf', '24', '-x264-params', 'threads=2:lookahead-threads=1']
    if encoder == 'libx265':
        return ['-preset', 'ultrafast', '-crf', '28', '-x265-params',
                'pools=2:frame-threads=1:wpp=0:log-level=error']
    if encoder == 'libvpx-vp9':
        return ['-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '0',
                '-tile-columns', '0', '-crf', '36', '-b:v', '0']
    if encoder == 'libaom-av1':
        return ['-cpu-used', '8', '-row-mt', '0', '-tiles', '1x1', '-crf', '40', '-b:v', '0']
    if encoder == 'libsvtav1':
        return ['-preset', '12', '-crf', '40', '-svtav1-params', 'lp=2']
    return []


def expected_frame(base, asset, time_pos):
    base = Path(base).resolve()
    base.mkdir(parents=True, exist_ok=True)
    time_pos = float(time_pos)
    if not math.isfinite(time_pos) or not 0 <= time_pos < DURATION:
        raise MediaError(f'time_pos must be finite and in [0, {DURATION}) seconds')
    commands = asset.setdefault('commands', []) if isinstance(asset, dict) else []
    path = Path(asset['path'] if isinstance(asset, dict) else asset).resolve()
    probe = _probe(base, path, commands)
    stream = _video(probe)
    if _is_hdr(stream):
        raise MediaError('HDR is unsupported: convert to SDR with explicit tone mapping before benchmarking.')
    if not stream:
        raise MediaError(f'No video stream in {path}')
    directory = base / 'media'
    directory.mkdir(exist_ok=True)
    token = hashlib.sha256(f'{path}:{_sha256(path)}:{time_pos:.9f}'.encode()).hexdigest()[:20]
    output = directory / f'{path.stem}-frame-{token}.png'
    # ffmpeg autorotation runs before filters; normalize SAR before fitting/cropping.
    fitting = ('scale=round(iw*sar):ih:flags=lanczos,setsar=1,'
               'scale=1024:768:force_original_aspect_ratio=increase:flags=lanczos,'
               'crop=1024:768,setsar=1')
    _run(base, _ffmpeg() + ['-i', path, '-ss', f'{time_pos:.9f}', '-map', '0:v:0',
                           '-vf', fitting, '-frames:v', '1', '-c:v', 'png',
                           '-threads', '2', '-update', '1', output], commands)
    image = _video(_probe(base, output, commands))
    if image.get('codec_name') != 'png' or (image.get('width'), image.get('height')) != (1024, 768):
        raise MediaError(f'Invalid reference PNG: {output}')
    return output


def stretched_frame(base, asset, time_pos):
    base = Path(base).resolve()
    time_pos = float(time_pos)
    if not math.isfinite(time_pos) or not 0 <= time_pos < DURATION:
        raise MediaError(f'time_pos must be finite and in [0, {DURATION}) seconds')
    commands = asset.setdefault('commands', []) if isinstance(asset, dict) else []
    path = Path(asset['path'] if isinstance(asset, dict) else asset).resolve()
    directory = base / 'media'
    directory.mkdir(parents=True, exist_ok=True)
    token = hashlib.sha256(f'{path}:{_sha256(path)}:{time_pos:.9f}:stretch'.encode()).hexdigest()[:20]
    output = directory / f'{path.stem}-stretchframe-{token}.png'
    # Authoritative full-frame geometry: autorotation applies (before filters);
    # SAR is normalized, then the whole frame is scaled to the canvas.
    fitting = 'scale=round(iw*sar):ih:flags=lanczos,setsar=1,scale=1024:768,setsar=1'
    _run(base, _ffmpeg() + ['-i', path, '-ss', f'{time_pos:.9f}', '-map', '0:v:0',
                             '-vf', fitting, '-frames:v', '1', '-c:v', 'png',
                             '-threads', '2', '-update', '1', output], commands)
    return output


def generate(base, names=None):
    base = Path(base).resolve()
    directory = base / 'media'
    directory.mkdir(parents=True, exist_ok=True)
    if isinstance(names, str):
        names = names.split(',')
    names = list(NAMES if names is None else names)
    unknown = set(names) - SPECS.keys()
    if unknown:
        raise MediaError(f'Unknown media names: {", ".join(sorted(unknown))}; choose {", ".join(SPECS)}')
    if len(names) != len(set(names)):
        raise MediaError('Media names must not be duplicated')
    discovery = []
    encoders = set()
    tools = all(shutil.which(tool) for tool in ('ffmpeg', 'ffprobe'))
    if tools:
        encoders = set(re.findall(r'^\s*V\S*\s+(\S+)',
                                 _run(base, ['ffmpeg', '-hide_banner', '-encoders'], discovery)
                                 .decode(), re.MULTILINE))
    manifest = []
    manifest_path = directory / ('manifest-hdr.json' if names == ['hdr'] else 'manifest.json')
    for name in names:
        suffix, encoder, codec, width, height = SPECS[name]
        if name == 'av1':
            encoder = next((item for item in ('libaom-av1', 'libsvtav1') if item in encoders), None)
        path = directory / f'{name}.{suffix}'
        entry = {'name': name, 'status': 'unsupported', 'path': str(path), 'still': None,
                 'sha256': None, 'still_sha256': None, 'probe': None, 'commands': list(discovery),
                 'encoder': encoder}
        manifest.append(entry)
        if not tools or encoder not in encoders:
            entry['reason'] = ('Install ffmpeg and ffprobe.' if not tools else
                               f'Missing encoder for {name}: install {encoder or "libaom-av1 or libsvtav1"}.')
            continue
        try:
            fps = 10 if name == 'gif' else 30
            filters = ['setsar=4/3'] if name == 'sar' else []
            options = []
            if name in ('sdr', 'hdr'):
                filters.append('setparams=color_primaries=' + ('bt2020' if name == 'hdr' else 'bt709') +
                               ':color_trc=' + ('smpte2084' if name == 'hdr' else 'bt709') +
                               ':colorspace=' + ('bt2020nc' if name == 'hdr' else 'bt709'))
            if name == 'gif':
                filters.append('format=rgb8')
                options += ['-loop', '0']
            else:
                options += ['-pix_fmt', 'yuv420p10le' if name == 'hdr' else 'yuv420p']
                if name in ('sdr', 'hdr'):
                    options += ['-color_primaries', 'bt2020' if name == 'hdr' else 'bt709',
                                '-color_trc', 'smpte2084' if name == 'hdr' else 'bt709',
                                '-colorspace', 'bt2020nc' if name == 'hdr' else 'bt709',
                                '-color_range', 'tv']
            target = directory / 'rotation-unrotated.mp4' if name == 'rotation' else path
            argv = _ffmpeg() + ['-f', 'lavfi', '-i',
                               f'testsrc2=size={width}x{height}:rate={fps}:duration={DURATION}',
                               '-t', str(DURATION), '-an', '-map_metadata', '-1']
            if filters:
                argv += ['-vf', ','.join(filters)]
            argv += ['-c:v', encoder, '-threads', '2', '-fflags', '+bitexact',
                     '-flags:v', '+bitexact'] + _encoder_options(encoder) + options + [target]
            _run(base, argv, entry['commands'])
            if name == 'rotation':
                _run(base, _ffmpeg() + ['-i', target, '-c', 'copy', '-map_metadata', '-1',
                                       '-metadata:s:v:0', 'rotate=90', path], entry['commands'])
                rotated = _video(_probe(base, path, entry['commands']))
                if not any(abs(float(item.get('rotation', 0))) == 90
                           for item in rotated.get('side_data_list', [])):
                    _run(base, _ffmpeg() + ['-display_rotation', '90', '-i', target,
                                           '-c', 'copy', path], entry['commands'])
                target.unlink()
            entry['probe'] = _probe(base, path, entry['commands'])
            stream = _video(entry['probe'])
            if (stream.get('codec_name') != codec or
                    (stream.get('width'), stream.get('height')) != (width, height)):
                raise MediaError(f'Expected {codec} {width}x{height}, got {stream}')
            if name == 'rotation' and not any(
                    abs(float(item.get('rotation', 0))) == 90
                    for item in stream.get('side_data_list', [])):
                raise MediaError('Rotation must be verified by ffprobe side_data rotation=±90, not a tag.')
            if name == 'sar' and stream.get('sample_aspect_ratio') != '4:3':
                raise MediaError('SAR fixture must probe as 4:3.')
            if name == 'hdr' and not _is_hdr(stream):
                raise MediaError('HDR negative control did not retain PQ metadata.')
            entry['sha256'] = _sha256(path)
            if name != 'hdr':
                entry['still'] = str(expected_frame(base, entry, 0))
                entry['still_sha256'] = _sha256(Path(entry['still']))
            else:
                entry['negative_control'] = True
            entry['status'] = 'ready'
        except (MediaError, OSError, subprocess.TimeoutExpired, ValueError) as error:
            entry['status'] = 'failed'
            entry['reason'] = str(error)
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def validate_manifest(manifest, allow_hdr=False):
    if isinstance(manifest, (str, Path)):
        manifest = json.loads(Path(manifest).read_text())
    if not isinstance(manifest, list) or not manifest:
        raise MediaError('Manifest must be a nonempty list of asset records.')
    ready = []
    for entry in manifest:
        if not isinstance(entry, dict) or entry.get('name') not in SPECS:
            raise MediaError('Manifest asset has an invalid name.')
        name = entry['name']
        if entry.get('status') == 'unsupported' and entry.get('reason'):
            continue
        if entry.get('status') != 'ready':
            raise MediaError(f'{name}: generation did not succeed: {entry.get("reason", "invalid status")}')
        stream = _video(entry.get('probe'))
        if _is_hdr(stream) and not allow_hdr:
            raise MediaError(f'{name}: HDR is unsupported. Convert to SDR with explicit tone mapping, '
                             'or use allow_hdr=True only to inspect the negative control; do not benchmark HDR.')
        _, _, codec, width, height = SPECS[name]
        if (type(stream.get('width')) is not int or type(stream.get('height')) is not int or
                (stream['width'], stream['height']) != (width, height)):
            raise MediaError(f'{name}: invalid dimensions; expected {width}x{height}.')
        if stream.get('codec_name') != codec:
            raise MediaError(f'{name}: invalid codec; expected {codec}.')
        digest = entry.get('sha256')
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise MediaError(f'{name}: sha256 must be 64 lowercase hexadecimal characters.')
        path = entry.get('path')
        if not isinstance(path, str) or not Path(path).is_file() or _sha256(Path(path)) != digest:
            raise MediaError(f'{name}: media file missing or sha256 mismatch; regenerate the fixture.')
        sar = stream.get('sample_aspect_ratio', '1:1')
        if sar != ('4:3' if name == 'sar' else '1:1'):
            raise MediaError(f'{name}: invalid sample aspect ratio {sar}.')
        rotations = [float(item.get('rotation', 0)) for item in stream.get('side_data_list', [])]
        if name == 'rotation':
            if not any(abs(rotation) == 90 for rotation in rotations):
                raise MediaError(f'{name}: missing verified ffprobe rotation side data.')
        elif any(rotation != 0 for rotation in rotations):
            raise MediaError(f'{name}: unexpected rotation side data.')
        if name == 'sdr' and (stream.get('color_primaries'), stream.get('color_transfer'),
                              stream.get('color_space')) != ('bt709', 'bt709', 'bt709'):
            raise MediaError(f'{name}: expected BT.709 SDR color tags.')
        if name == 'hdr' and not _is_hdr(stream):
            raise MediaError(f'{name}: expected HDR transfer metadata for the negative control.')
        if not _is_hdr(stream):
            still = entry.get('still')
            still_digest = entry.get('still_sha256')
            if not isinstance(still, str) or not Path(still).is_file():
                raise MediaError(f'{name}: matching PNG still is missing.')
            if (not isinstance(still_digest, str) or
                    not re.fullmatch(r'[0-9a-f]{64}', still_digest) or
                    _sha256(Path(still)) != still_digest):
                raise MediaError(f'{name}: still sha256 missing or mismatched; regenerate the fixture.')
        if not isinstance(entry.get('commands'), list) or not entry['commands']:
            raise MediaError(f'{name}: generation commands are missing.')
        ready.append(entry)
    return ready


def main():
    parser = argparse.ArgumentParser(description='Generate offline bounded T10 media fixtures')
    parser.add_argument('--base', required=True, type=Path)
    parser.add_argument('--names', default=','.join(NAMES))
    options = parser.parse_args()
    manifest = generate(options.base, options.names)
    for entry in manifest:
        print(entry['name'], entry['status'], entry.get('reason', entry['path']))
    validate_manifest(manifest, allow_hdr=options.names == 'hdr')
    return 0 if all(entry['status'] == 'ready' for entry in manifest) else 1


if __name__ == '__main__':
    raise SystemExit(main())
