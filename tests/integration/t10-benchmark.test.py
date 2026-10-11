#!/usr/bin/env python3
import importlib.util
import math
from pathlib import Path
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load('runner', 'run-t10-benchmark.py')


class BenchmarkTests(unittest.TestCase):
    def test_aggregation(self):
        self.assertEqual(runner.aggregate([1, 3, None, float('nan'), True]),
                         {'count': 2, 'min': 1, 'mean': 2, 'max': 3})

    def test_missing_data(self):
        self.assertEqual(runner.aggregate([None, math.inf]),
                         {'count': 0, 'min': None, 'mean': None, 'max': None})

    def test_loop_wrap(self):
        self.assertAlmostEqual(runner.advancement(7.5, 0.5, 8), 1)
        self.assertEqual(runner.advancement(2, 2, 8), 0)
        self.assertIsNone(runner.advancement(None, 2, 8))

    def test_resume(self):
        manifests = [{'name': 'h264', 'sha256': 'a', 'path': '/x'}]
        config = {'seconds': 60, 'vos': 'dmabuf-wayland', 'hwdecs': 'vaapi'}
        runner.verify_resume({'fingerprint': 'same', 'assets': manifests, 'config': config},
                             'same', manifests, config)
        with self.assertRaises(ValueError):
            runner.verify_resume({'fingerprint': 'old', 'assets': [{'name': 'other'}],
                                  'config': config}, 'new', manifests, config)
        with self.assertRaises(ValueError):
            runner.verify_resume({'fingerprint': 'old', 'assets': manifests,
                                  'config': {**config, 'seconds': 30}}, 'new', manifests, config)
        migration = runner.verify_resume({'fingerprint': 'old', 'assets': manifests,
                                          'config': config}, 'new', manifests, config)
        self.assertEqual(migration, 'harness sources changed; assets and configuration identical')

    def test_nearest_reference_uses_best_offset(self):
        class Media:
            @staticmethod
            def expected_frame(root, asset, position):
                return position

        pixels = {0.5: bytes([10, 10]), 1.0: bytes([0, 0]), 1.5: bytes([50, 50])}
        with patch.object(runner, 'image_pixels', side_effect=lambda root, frame: pixels.get(frame, bytes([90, 90]))):
            distance = runner.nearest_reference_distance(Media, None, None, 1.0, bytes([0, 0]))
        self.assertEqual(distance, 0)
        with patch.object(runner, 'image_pixels', return_value=bytes([0, 0])):
            distance = runner.nearest_reference_distance(Media, None, None, 1.0, bytes([100, 100]))
        self.assertEqual(distance, 100)

    def test_failure_classification(self):
        self.assertEqual(runner.classify([], 'timeout'), 'watchdog-or-harness-failed')
        self.assertEqual(runner.classify([{'event': 'fail'}]), 'playback-or-readiness-failed')
        self.assertEqual(runner.classify([{'event': 'complete'}]), 'incomplete-evidence')
        self.assertEqual(runner.classify([{'event': e} for e in
                         ('content-ready', 'first-frame-ready', 'complete', 'audit')]),
                         'pending-capture-validation')

    def test_media_manifest_validation_and_hdr_rejection(self):
        media = runner.load_media()
        # Invalid manifest type
        with self.assertRaises(media.MediaError):
            media.validate_manifest({})
        # Empty manifest
        with self.assertRaises(media.MediaError):
            media.validate_manifest([])
        # Synthesized HDR record rejected with actionable message
        hdr_entry = {'name': 'hdr', 'status': 'ready', 'path': '/nonexistent',
                     'sha256': '0' * 64, 'still': None, 'commands': [['cmd']],
                     'probe': {'streams': [{'codec_type': 'video', 'codec_name': 'hevc',
                                            'width': 1920, 'height': 1080,
                                            'color_transfer': 'smpte2084'}]}}
        with self.assertRaises(media.MediaError) as ctx:
            media.validate_manifest([hdr_entry], allow_hdr=False)
        self.assertIn('HDR is unsupported', str(ctx.exception))
        self.assertIn('tone mapping', str(ctx.exception))


if __name__ == '__main__':
    unittest.main()
