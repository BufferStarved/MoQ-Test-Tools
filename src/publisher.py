import csv
import json
import os
import glob
from collections import defaultdict


class MetricsPublisher:
    def __init__(self, results_dir: str = "results"):
        self.results_dir = results_dir

    def get_latest_csv(self) -> str:
        list_of_files = glob.glob(f"{self.results_dir}/*.csv")
        if not list_of_files:
            raise FileNotFoundError(f"No CSV files found in {self.results_dir}/")
        return max(list_of_files, key=os.path.getctime)

    def analyze_and_publish(self):
        latest_file = self.get_latest_csv()
        print(f"Analyzing data from: {latest_file}\n")

        stats = defaultdict(lambda: {
            "cpu_sum": 0.0,
            "mem_sum": 0.0,
            "bitrate_sum": 0.0,
            "fps_sum": 0.0,
            "speed_sum": 0.0,
            "count": 0,
            "endpoint": "",
        })

        with open(latest_file, mode="r") as file:
            reader = csv.DictReader(file)
            for row in reader:
                protocol = row["protocol"]
                stats[protocol]["cpu_sum"] += float(row["cpu_percent"])
                stats[protocol]["mem_sum"] += float(row["memory_mb"])
                stats[protocol]["bitrate_sum"] += float(row.get("bitrate_kbps", 0) or 0)
                stats[protocol]["fps_sum"] += float(row.get("fps", 0) or 0)
                stats[protocol]["speed_sum"] += float(row.get("speed", 0) or 0)
                stats[protocol]["count"] += 1
                stats[protocol]["endpoint"] = row.get("endpoint", "")

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
                    "average_speed": round(data["speed_sum"] / count, 2),
                    "samples_collected": count,
                }

        print(json.dumps(payload, indent=4))

        # Here is where you would normally POST this payload to an API endpoint
        # requests.post("https://metrics.yourcompany.com/ingest", json=payload)


if __name__ == "__main__":
    try:
        publisher = MetricsPublisher()
        publisher.analyze_and_publish()
    except Exception as exc:
        print(f"Failed to publish metrics: {exc}")
