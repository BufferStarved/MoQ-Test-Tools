import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from encoder_capture import build_tee_output_args, encoder_capture_filename, encoder_capture_path
from quality_metrics import patch_summary_quality_leg, quality_leg_from_vmaf_result
from vmaf_score import VmafResult


class EncoderCaptureTests(unittest.TestCase):
    def test_encoder_capture_filename_by_protocol(self):
        self.assertEqual(encoder_capture_filename("moq"), "encoder_capture.mp4")
        self.assertEqual(encoder_capture_filename("rtmp"), "encoder_capture.flv")
        self.assertEqual(encoder_capture_filename("srt"), "encoder_capture.ts")

    def test_encoder_capture_path(self):
        self.assertTrue(
            encoder_capture_path("/tmp/bench", "moq").endswith("encoder_capture.mp4")
        )

    def test_build_tee_output_args_srt(self):
        args = build_tee_output_args("srt", "srt://host:10080", "/tmp/capture.ts")
        self.assertEqual(args[0:4], ["-map", "0", "-bsf:v", "h264_mp4toannexb"])
        self.assertEqual(args[4:6], ["-f", "tee"])
        self.assertIn("srt://host:10080", args[6])
        self.assertIn("/tmp/capture.ts", args[6])

    def test_build_tee_output_args_rtmp(self):
        args = build_tee_output_args("rtmp", "rtmp://host/live/key", "/tmp/capture.flv")
        self.assertEqual(args[0:2], ["-map", "0"])
        self.assertIn("rtmp://host/live/key", args[4])
        self.assertIn("/tmp/capture.flv", args[4])


class QualityMetricsTests(unittest.TestCase):
    def test_patch_summary_quality_leg(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            summary_path = os.path.join(temp_dir, "run.summary.json")
            with open(summary_path, "w", encoding="utf-8") as handle:
                json.dump({"averages": {}, "extra": {}}, handle)

            leg = quality_leg_from_vmaf_result(
                VmafResult(vmaf_score=91.5, psnr_db=42.0, ssim=0.98),
                status="completed",
                computed_on="local",
                distorted_path="/tmp/capture.mp4",
            )
            patch_summary_quality_leg(summary_path, "encoder", leg)

            with open(summary_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)

            self.assertEqual(payload["quality"]["encoder"]["vmaf_score"], 91.5)
            self.assertEqual(payload["quality"]["encoder"]["computed_on"], "local")


if __name__ == "__main__":
    unittest.main()
