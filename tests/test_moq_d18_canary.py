"""Draft-18 canary preset stays off the prod :4433 path."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from cloud_placement import ingest_endpoint_id_for_provider  # noqa: E402
from destinations import PRESET_BY_ID  # noqa: E402
from moq_publish import (  # noqa: E402
    MOQ5_MISSING_HINT,
    build_ffmpeg_moq_cmd,
    build_moq_publisher_cmd,
    classify_job_exception,
    classify_spawn_oserror,
    combine_ffmpeg_closed_pipe_error,
    describe_moq_connect_failure,
    find_moq_publisher,
    infer_moq_draft_from_url,
    is_bare_eio_message,
    looks_like_closed_pipe_eio,
    moq_publisher_backend_for_preset,
    parse_moq_publish_url,
)


class Draft18CanaryPresetTests(unittest.TestCase):
    def test_prod_preset_stays_on_4433(self) -> None:
        preset = PRESET_BY_ID["moq_gcp_relay"]
        self.assertIn(":4433/", preset.url)
        self.assertNotIn(":14433", preset.url)
        self.assertEqual(preset.ingest_provider, "gcp_moq_relay")
        self.assertFalse(preset.web_visible)

    def test_legacy_d16_relays_hidden_from_web(self) -> None:
        for preset_id in ("moq_gcp_relay", "moq_gcp_east_relay", "moq_linode_relay"):
            preset = PRESET_BY_ID.get(preset_id)
            if preset is None:
                continue
            self.assertFalse(preset.web_visible, preset_id)

    def test_canary_preset_points_at_14433_draft_18(self) -> None:
        preset = PRESET_BY_ID["moq_gcp_relay_d18"]
        self.assertIn(":14433/", preset.url)
        self.assertIn("draft=18", preset.url)
        self.assertTrue(preset.web_visible)
        self.assertTrue(preset.web_available)
        target = parse_moq_publish_url(preset.url)
        self.assertEqual(target.draft, 18)
        self.assertTrue(target.endpoint.endswith(":14433/moq-relay"))

    def test_canary_forces_moq5_even_when_env_says_openmoq(self) -> None:
        self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_relay_d18"), "moq5")
        self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_east_relay_d18"), "moq5")
        self.assertEqual(moq_publisher_backend_for_preset("moq_linode_relay_d18"), "moq5")
        with patch.dict(os.environ, {"MOQ_PUBLISHER_BACKEND": "openmoq"}):
            self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_relay_d18"), "moq5")
            self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_east_relay_d18"), "moq5")
            self.assertEqual(moq_publisher_backend_for_preset("moq_linode_relay_d18"), "moq5")
            self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_relay"), "openmoq")
            self.assertEqual(moq_publisher_backend_for_preset(""), "openmoq")
            # Lost preset_id: still force moq5 from the canary URL, never prod :4433.
            self.assertEqual(
                moq_publisher_backend_for_preset(
                    "",
                    url="https://34-28-164-90.sslip.io:14433/moq-relay?namespace=bench&draft=18",
                ),
                "moq5",
            )
            self.assertEqual(
                moq_publisher_backend_for_preset(
                    "",
                    url="https://34-28-164-90.sslip.io:4433/moq-relay?namespace=benchmark",
                    draft=18,
                ),
                "openmoq",
            )

    def test_canary_path_uses_moq5_live_catalog_init(self) -> None:
        install = (ROOT / "scripts" / "install-moq5.sh").read_text()
        self.assertIn("openmoq/moq5.git", install)
        self.assertIn("MOQ5_REF:-main", install)
        self.assertIn("live-write-publish-tracks-catalog.patch", install)
        self.assertIn("tools/moq5-publisher/bin/moq5-fmp4-publish", install)

        publish = (ROOT / "src" / "moq_publish.py").read_text()
        self.assertIn("tools\", \"moq5-publisher\", \"bin\", \"moq5-fmp4-publish\"", publish)
        self.assertIn("tools\", \"moq5-publisher\", \"build\", \"moq5-fmp4-publish\"", publish)
        upload = (ROOT / "src" / "upload_service.py").read_text()
        start = upload.index("def _run_moq_pipeline")
        body = upload[start : upload.index("\n    def _finalize_result", start)]
        self.assertIn("find_moq_publisher(", body)
        self.assertIn("url=job.destination.url", body)
        self.assertIn("draft=target.draft", body)
        self.assertIn("MOQ5_MISSING_HINT", body)
        self.assertIn("classify_spawn_oserror", body)
        self.assertIn("combine_ffmpeg_closed_pipe_error", body)

        bridge = (ROOT / "tools" / "moq5-publisher" / "fmp4_moq_bridge.c").read_text()
        self.assertIn("moq_media_sender_cfg_init_live_sized", bridge)
        self.assertIn("cfg->publish_tracks = true", bridge)
        # First live catalog must wait for moov; attach-at-CONNECT wrote
        # `{tracks:[]}` and playa FETCH one-shotted the empty object.
        self.assertIn("waiting for ftyp+moov before sender attach", bridge)
        self.assertIn("attaching sender after CMAF init", bridge)
        self.assertIn("ensure_sender_attached", bridge)
        self.assertIn("activate_tracks", bridge)

    def test_ingest_provider_maps_to_distinct_ui_endpoint(self) -> None:
        self.assertEqual(ingest_endpoint_id_for_provider("gcp_moq_relay"), "gcp_moq_relay")
        self.assertEqual(
            ingest_endpoint_id_for_provider("gcp_moq_relay_d18"), "gcp_moq_relay_d18"
        )
        self.assertEqual(
            ingest_endpoint_id_for_provider("gcp_east_moq_relay_d18"),
            "gcp_east_moq_relay_d18",
        )
        self.assertEqual(
            ingest_endpoint_id_for_provider("linode_moq_relay_d18"),
            "linode_moq_relay_d18",
        )

    def test_d18_ingest_resolves_real_moq5_executable_not_openmoq(self) -> None:
        preset = PRESET_BY_ID["moq_gcp_relay_d18"]
        path, backend = find_moq_publisher(
            preset.id,
            url=preset.url,
            draft=18,
        )
        self.assertEqual(backend, "moq5")
        self.assertIsNotNone(path)
        self.assertTrue(os.path.isfile(path), path)  # type: ignore[arg-type]
        self.assertTrue(os.access(path, os.X_OK), path)  # type: ignore[arg-type]
        self.assertIn("moq5-fmp4-publish", path)  # type: ignore[arg-type]
        self.assertNotIn("openmoq-publisher", path)  # type: ignore[arg-type]
        target = parse_moq_publish_url(preset.url)
        cmd = build_moq_publisher_cmd(path or "", backend, target, duration_sec=8)
        self.assertEqual(cmd[0], path)
        self.assertNotIn("openmoq-publisher", " ".join(cmd))
        self.assertIn(target.endpoint, cmd)
        self.assertIn(target.namespace, cmd)

    def test_d18_missing_moq5_binary_is_explicit(self) -> None:
        with patch("moq_publish.find_moq5_publisher", return_value=None):
            path, backend = find_moq_publisher(
                "moq_gcp_relay_d18",
                url="https://34-28-164-90.sslip.io:14433/moq-relay?namespace=bench&draft=18",
            )
        self.assertEqual(backend, "moq5")
        self.assertIsNone(path)
        missing = classify_spawn_oserror(
            FileNotFoundError(2, "No such file or directory"),
            role="moq5",
            binary="",
        )
        self.assertEqual(missing, MOQ5_MISSING_HINT)
        spawn_eio = classify_spawn_oserror(
            OSError(5, "Input/output error"),
            role="moq5",
            binary="/tmp/moq5-fmp4-publish",
        )
        self.assertIn("Failed to start MoQ publisher", spawn_eio)
        self.assertNotIn("openmoq-publisher", spawn_eio)
        camera = classify_spawn_oserror(
            OSError(5, "Input/output error"),
            role="camera",
            binary="/opt/homebrew/bin/ffmpeg",
            media_path="device:webcam",
        )
        self.assertIn("camera I/O error", camera)
        self.assertFalse(is_bare_eio_message(camera))

        job_eio = classify_spawn_oserror(
            OSError(5, "Input/output error"),
            role="job",
            media_path="dummy.mp4",
        )
        self.assertNotEqual(job_eio, "[Errno 5] Input/output error")
        self.assertIn("publish I/O error", job_eio)

        webcam_job = classify_job_exception(
            OSError(5, "Input/output error"),
            media_path="device:webcam",
        )
        self.assertIn("ffmpeg I/O error", webcam_job)
        self.assertFalse(is_bare_eio_message(webcam_job))

        wrapped = classify_job_exception(
            RuntimeError("[Errno 5] Input/output error"),
            media_path="device:webcam",
        )
        self.assertIn("ffmpeg I/O error", wrapped)
        self.assertFalse(is_bare_eio_message(wrapped))

        camera = classify_job_exception(
            OSError(5, "Input/output error"),
            media_path="device:webcam",
            role="camera",
        )
        self.assertIn("camera I/O error", camera)

        pipe = combine_ffmpeg_closed_pipe_error(
            "ffmpeg exited with code 141: Error writing trailer: Input/output error",
            "stdin EOF before ftyp box\nwaiting for ftyp+moov before sender attach",
            backend="moq5",
            code=1,
        )
        self.assertIn("before WebTransport CONNECT", pipe)
        self.assertIn("ftyp", pipe)
        self.assertFalse(is_bare_eio_message(pipe))
        self.assertTrue(
            looks_like_closed_pipe_eio(
                "ffmpeg exited with code 1: Error writing trailer: Input/output error | pipe:1"
            )
        )

    def test_webcam_d18_argv_uses_moq5_and_not_avfoundation_after_broker(self) -> None:
        """After the webcam broker rewrites media_path to udp://, encode is not avfoundation."""
        preset = PRESET_BY_ID["moq_gcp_relay_d18"]
        target = parse_moq_publish_url(
            preset.url.replace("namespace=benchmark", "namespace=bench-f71e6fae")
        )
        path, backend = find_moq_publisher(preset.id, url=preset.url, draft=18)
        self.assertEqual(backend, "moq5")
        self.assertIsNotNone(path)
        pub = build_moq_publisher_cmd(path or "", backend, target, duration_sec=30)
        self.assertIn(":14433", " ".join(pub))
        self.assertIn("bench-f71e6fae", pub)
        self.assertNotIn("openmoq-publisher", " ".join(pub))

        brokered = "udp://127.0.0.1:50123?timeout=15000000&fifo_size=1000000"
        ffmpeg = build_ffmpeg_moq_cmd(
            brokered,
            progress_path="/tmp/ffmpeg-progress.txt",
            duration_sec=30,
        )
        joined = " ".join(ffmpeg)
        self.assertIn(brokered, joined)
        self.assertNotIn("avfoundation", joined)
        self.assertNotIn("v4l2", joined)
        self.assertIn("pipe:1", joined)
        self.assertIn("empty_moov", joined)

    def test_regional_canary_presets_use_14433_when_stack_configured(self) -> None:
        for preset_id in ("moq_gcp_east_relay_d18", "moq_linode_relay_d18"):
            preset = PRESET_BY_ID.get(preset_id)
            if preset is None or not preset.web_available:
                continue
            self.assertIn(":14433/", preset.url)
            self.assertIn("draft=18", preset.url)
            target = parse_moq_publish_url(preset.url)
            self.assertEqual(target.draft, 18)
            self.assertTrue(target.endpoint.endswith(":14433/moq-relay"))

    def test_every_d18_or_draft18_label_stays_off_4433(self) -> None:
        for preset in PRESET_BY_ID.values():
            hay = f"{preset.id} {preset.name} {preset.ingest_provider}".lower()
            if "d18" not in hay and "draft-18" not in hay and "draft 18" not in hay:
                continue
            if not preset.url:
                self.assertFalse(preset.web_available, preset.id)
                self.assertIn("14433", preset.notes, preset.id)
                self.assertNotIn(":4433", preset.notes.replace("not leftover :4433", ""), preset.id)
                continue
            self.assertIn(":14433/", preset.url, preset.id)
            self.assertIn("draft=18", preset.url, preset.id)
            self.assertNotIn(":4433", preset.url, preset.id)
            self.assertEqual(parse_moq_publish_url(preset.url).draft, 18, preset.id)
            self.assertNotIn("draft-18", (PRESET_BY_ID.get("moq_gcp_relay").name or "").lower())

    def test_prod_4433_url_without_draft_query_is_draft_16(self) -> None:
        west = "https://34-28-164-90.sslip.io:4433/moq-relay?namespace=benchmark"
        self.assertEqual(infer_moq_draft_from_url(west), 16)
        self.assertEqual(parse_moq_publish_url(west).draft, 16)
        self.assertEqual(
            infer_moq_draft_from_url(
                "https://34-28-164-90.sslip.io:14433/moq-relay?namespace=benchmark"
            ),
            18,
        )

    def test_connect_failure_names_relay_binary_and_4433_mismatch(self) -> None:
        openmoq = describe_moq_connect_failure(
            endpoint="https://34-28-164-90.sslip.io:4433/moq-relay",
            backend="openmoq",
            binary="/opt/openmoq-publisher",
            draft=16,
        )
        self.assertIn("relay=https://34-28-164-90.sslip.io:4433/moq-relay", openmoq)
        self.assertIn("binary=/opt/openmoq-publisher", openmoq)
        self.assertIn("did not connect", openmoq)
        self.assertNotIn("never started", openmoq.lower())
        moq5 = describe_moq_connect_failure(
            endpoint="https://34-28-164-90.sslip.io:4433/moq-relay",
            backend="moq5",
            binary="/tmp/moq5-fmp4-publish",
            draft=18,
        )
        self.assertIn("moq5-fmp4-publish", moq5)
        self.assertIn("draft-16", moq5)
        self.assertIn(":14433", moq5)
        spawn = classify_spawn_oserror(
            OSError(5, "Input/output error"),
            role="moq5",
            binary="/tmp/moq5-fmp4-publish",
            relay_url="https://34-28-164-90.sslip.io:14433/moq-relay",
        )
        self.assertIn("Failed to start MoQ publisher", spawn)
        self.assertIn(":14433", spawn)
        self.assertIn("/tmp/moq5-fmp4-publish", spawn)

    def test_file_source_probe_script_stays_off_camera_and_prod(self) -> None:
        script = (ROOT / "scripts" / "probe_d18_publish.py").read_text()
        self.assertIn("dummy.mp4", script)
        self.assertIn("moq_gcp_relay_d18", script)
        self.assertIn(":14433", script)
        self.assertIn("moq5-fmp4-publish", script)
        self.assertIn("moq5-fmp4-record", script)
        self.assertNotIn("device:webcam", script)
        self.assertIn("Does not change prod", script)


if __name__ == "__main__":
    unittest.main()
