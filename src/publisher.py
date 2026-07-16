import csv
import json
import os
import glob
from collections import defaultdict
from typing import Optional


class MetricsPublisher:
    def __init__(self, results_dir: str = "results"):
        self.results_dir = results_dir

    def get_latest_csv(self) -> str:
        list_of_files = glob.glob(f"{self.results_dir}/*.csv")
        if not list_of_files:
            raise FileNotFoundError(f"No CSV files found in {self.results_dir}/")
        return max(list_of_files, key=os.path.getctime)

    def get_summary_for_csv(self, csv_path: str) -> Optional[dict]:
        base, _ = os.path.splitext(csv_path)
        summary_path = f"{base}.summary.json"
        if not os.path.exists(summary_path):
            return None
        with open(summary_path, mode="r") as file:
            return json.load(file)

    def analyze_and_publish(self):
        latest_file = self.get_latest_csv()
        print(f"Analyzing data from: {latest_file}\n")

        summary = self.get_summary_for_csv(latest_file)
        if summary:
            payload = {
                "source_csv": latest_file,
                "source_summary": f"{os.path.splitext(latest_file)[0]}.summary.json",
                "protocol": summary.get("protocol"),
                "endpoint": summary.get("endpoint"),
                "samples": summary.get("samples"),
                "averages": summary.get("averages", {}),
                "srt": summary.get("srt", {}),
                "extra": summary.get("extra", {}),
            }
            print(json.dumps(payload, indent=4))
            return

        stats = defaultdict(lambda: {
            "cpu_sum": 0.0,
            "mem_sum": 0.0,
            "bitrate_sum": 0.0,
            "fps_sum": 0.0,
            "fps_stability_sum": 0.0,
            "speed_sum": 0.0,
            "rtt_sum": 0.0,
            "jitter_sum": 0.0,
            "count": 0,
            "endpoint": "",
            "pkt_rcv_drop": 0,
            "pkt_snd_drop": 0,
            "pkt_retrans": 0,
            "pkt_fec_extra": 0,
            "ts_continuity_counter_errors": 0,
            "vmaf_score": None,
        })

        with open(latest_file, mode="r") as file:
            reader = csv.DictReader(file)
            for row in reader:
                protocol = row["protocol"]
                stats[protocol]["cpu_sum"] += float(row["cpu_percent"])
                stats[protocol]["mem_sum"] += float(row["memory_mb"])
                stats[protocol]["bitrate_sum"] += float(
                    row.get("encoded_bitrate_kbps") or row.get("bitrate_kbps", 0) or 0
                )
                stats[protocol]["fps_sum"] += float(row.get("fps", 0) or 0)
                stats[protocol]["fps_stability_sum"] += float(row.get("fps_stability", 0) or 0)
                stats[protocol]["speed_sum"] += float(row.get("speed", 0) or 0)
                stats[protocol]["rtt_sum"] += float(
                    row.get("transport_rtt_ms") or row.get("rtt_ms", 0) or 0
                )
                stats[protocol]["jitter_sum"] += float(
                    row.get("transport_rtt_jitter_ms") or row.get("rtt_jitter_ms", 0) or 0
                )
                stats[protocol]["count"] += 1
                stats[protocol]["endpoint"] = row.get("endpoint", "")
                stats[protocol]["pkt_rcv_drop"] = int(float(row.get("pkt_rcv_drop", 0) or 0))
                stats[protocol]["pkt_snd_drop"] = int(float(row.get("pkt_snd_drop", 0) or 0))
                stats[protocol]["pkt_retrans"] = int(float(row.get("pkt_retrans", 0) or 0))
                stats[protocol]["pkt_fec_extra"] = int(float(row.get("pkt_fec_extra", 0) or 0))
                stats[protocol]["ts_continuity_counter_errors"] = int(
                    float(
                        row.get("ts_continuity_counter_errors")
                        or row.get("cc_errors", 0)
                        or 0
                    )
                )
                if row.get("vmaf_score"):
                    stats[protocol]["vmaf_score"] = float(row["vmaf_score"])

        payload = {"upload_results": {}}
        for protocol, data in stats.items():
            if data["count"] > 0:
                count = data["count"]
                payload["upload_results"][protocol] = {
                    "endpoint": data["endpoint"],
                    "average_cpu_percent": round(data["cpu_sum"] / count, 2),
                    "average_memory_mb": round(data["mem_sum"] / count, 2),
                    "average_bitrate_kbps": round(data["bitrate_sum"] / count, 2),
                    "average_fps": round(data["fps_sum"] / count, 2),
                    "average_fps_stability": round(data["fps_stability_sum"] / count, 4),
                    "average_speed": round(data["speed_sum"] / count, 2),
                    "average_rtt_ms": round(data["rtt_sum"] / count, 3),
                    "average_jitter_ms": round(data["jitter_sum"] / count, 3),
                    "pkt_rcv_drop": data["pkt_rcv_drop"],
                    "pkt_snd_drop": data["pkt_snd_drop"],
                    "pkt_retrans": data["pkt_retrans"],
                    "pkt_fec_extra": data["pkt_fec_extra"],
                    "ts_continuity_counter_errors": data["ts_continuity_counter_errors"],
                    "vmaf_score": data["vmaf_score"],
                    "samples_collected": count,
                }

        print(json.dumps(payload, indent=4))


if __name__ == "__main__":
    try:
        publisher = MetricsPublisher()
        publisher.analyze_and_publish()
    except Exception as exc:
        print(f"Failed to publish metrics: {exc}")
