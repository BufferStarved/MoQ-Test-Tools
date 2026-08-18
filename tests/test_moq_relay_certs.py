from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from moq_relay_certs import (  # noqa: E402
    MOQ_RELAY_CERT_SHA256,
    fingerprint_for_host,
    fingerprint_for_relay_url,
)


class MoqRelayCertsTests(unittest.TestCase):
    def test_all_production_relays_are_pinned(self):
        self.assertEqual(len(MOQ_RELAY_CERT_SHA256), 3)
        for host, digest in MOQ_RELAY_CERT_SHA256.items():
            self.assertRegex(digest, r"^[0-9a-f]{64}$", host)
            self.assertTrue(host.endswith(".sslip.io"), host)

    def test_lookup_ignores_case_and_strips(self):
        expected = "3cfec20ab9f6905b1765037d0a37e198cc9e07245f008570f11d566e853f1cf6"
        self.assertEqual(fingerprint_for_host("34-28-164-90.sslip.io"), expected)
        self.assertEqual(fingerprint_for_host("  34-28-164-90.SSLip.IO  "), expected)

    def test_url_lookup(self):
        url = "https://34-138-137-211.sslip.io:4433/moq-relay?namespace=bench-abc"
        self.assertEqual(
            fingerprint_for_relay_url(url),
            "13e87aa62f8996119ade0612fbae33426598d50c5125847d301a9d13ac269c9a",
        )

    def test_recorder_cert_map_stays_in_sync(self):
        cert_mjs = (ROOT / "tools/openmoq-recorder/cert.mjs").read_text()
        for host, digest in MOQ_RELAY_CERT_SHA256.items():
            self.assertIn(host, cert_mjs)
            self.assertIn(digest, cert_mjs)

    def test_unknown_host_is_none(self):
        self.assertIsNone(fingerprint_for_host("example.com"))
        self.assertIsNone(fingerprint_for_relay_url("https://example.com:4433/moq"))


if __name__ == "__main__":
    unittest.main()
