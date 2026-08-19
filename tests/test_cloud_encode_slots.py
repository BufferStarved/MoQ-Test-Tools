"""Cloud encode slot cap: serialize concurrent ffmpeg on the orchestrator VM."""

from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from cloud_encode_slots import (  # noqa: E402
    CloudEncodeSlotPool,
    encode_slot_fields,
    job_needs_cloud_encode_slot,
    max_concurrent_cloud_encodes,
)


class CloudEncodeSlotTests(unittest.TestCase):
    def test_browser_and_local_skip_the_vm_slot(self):
        self.assertTrue(job_needs_cloud_encode_slot("cloud"))
        self.assertTrue(job_needs_cloud_encode_slot(""))
        self.assertFalse(job_needs_cloud_encode_slot("browser"))
        self.assertFalse(job_needs_cloud_encode_slot("local"))

    def test_env_cap_defaults_to_one(self):
        self.assertEqual(max_concurrent_cloud_encodes(), 1)

    def test_second_job_waits_until_first_releases(self):
        pool = CloudEncodeSlotPool(limit=1)
        first_ready = threading.Event()
        second_held = threading.Event()
        cancel = threading.Event()

        def hold_first() -> None:
            self.assertTrue(pool.acquire("a", cancel))
            first_ready.set()
            time.sleep(0.15)
            pool.release("a")

        def take_second() -> None:
            first_ready.wait(timeout=1)
            self.assertTrue(pool.acquire("b", cancel, timeout=0.05))
            second_held.set()
            pool.release("b")

        t1 = threading.Thread(target=hold_first)
        t2 = threading.Thread(target=take_second)
        t1.start()
        t2.start()
        t1.join(timeout=2)
        t2.join(timeout=2)
        self.assertTrue(second_held.is_set())
        self.assertEqual(pool.held_count(), 0)

    def test_cancel_while_queued_does_not_take_a_slot(self):
        pool = CloudEncodeSlotPool(limit=1)
        blocker = threading.Event()
        self.assertTrue(pool.acquire("held", blocker))
        cancel = threading.Event()

        def waiter() -> None:
            self.assertFalse(pool.acquire("queued", cancel, timeout=0.05))

        t = threading.Thread(target=waiter)
        t.start()
        time.sleep(0.08)
        cancel.set()
        t.join(timeout=2)
        self.assertEqual(pool.held_count(), 1)
        pool.release("held")
        self.assertEqual(pool.held_count(), 0)

    def test_queue_ahead_is_fifo_and_api_fields_name_the_slot(self):
        pool = CloudEncodeSlotPool(limit=1)
        cancel = threading.Event()
        self.assertTrue(pool.acquire("held", cancel))
        waiting = threading.Event()

        def waiter() -> None:
            waiting.set()
            self.assertTrue(pool.acquire("queued", cancel, timeout=0.05))
            pool.release("queued")

        t = threading.Thread(target=waiter)
        t.start()
        waiting.wait(timeout=1)
        time.sleep(0.05)
        self.assertEqual(pool.queue_ahead("queued"), 1)
        fields = encode_slot_fields(
            pool,
            job_id="queued",
            publisher_host="cloud",
            status="queued",
        )
        self.assertTrue(fields["waiting_for_encode_slot"])
        self.assertEqual(fields["encode_queue_ahead"], 1)
        self.assertEqual(fields["encode_slot_limit"], 1)
        browser = encode_slot_fields(
            pool,
            job_id="browser-1",
            publisher_host="browser",
            status="queued",
        )
        self.assertFalse(browser["waiting_for_encode_slot"])
        cancel.set()
        pool.release("held")
        t.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
