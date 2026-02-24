import csv
import json
import os
import glob
from collections import defaultdict

class MetricsPublisher:
    def __init__(self, results_dir: str = "results"):
        self.results_dir = results_dir

    def get_latest_csv(self) -> str:
        """Finds the most recently generated benchmark CSV."""
        list_of_files = glob.glob(f"{self.results_dir}/*.csv")
        if not list_of_files:
            raise FileNotFoundError(f"No CSV files found in {self.results_dir}/")
        return max(list_of_files, key=os.path.getctime)

    def analyze_and_publish(self):
        latest_file = self.get_latest_csv()
        print(f"Analyzing data from: {latest_file}\n")
        
        # Data structure to hold our sums and counts
        # Format: { 'SRT-Mock': {'cpu_sum': 0, 'mem_sum': 0, 'count': 0} }
        stats = defaultdict(lambda: {'cpu_sum': 0.0, 'mem_sum': 0.0, 'count': 0})

        with open(latest_file, mode='r') as file:
            reader = csv.DictReader(file)
            for row in reader:
                protocol = row['protocol']
                stats[protocol]['cpu_sum'] += float(row['cpu_percent'])
                stats[protocol]['mem_sum'] += float(row['memory_mb'])
                stats[protocol]['count'] += 1

        # Calculate averages and format the payload
        payload = {"benchmark_results": {}}
        for protocol, data in stats.items():
            if data['count'] > 0:
                avg_cpu = data['cpu_sum'] / data['count']
                avg_mem = data['mem_sum'] / data['count']
                payload["benchmark_results"][protocol] = {
                    "average_cpu_percent": round(avg_cpu, 2),
                    "average_memory_mb": round(avg_mem, 2),
                    "samples_collected": data['count']
                }

        # Print the final "Prod-Ready" JSON payload
        print(json.dumps(payload, indent=4))
        
        # Here is where you would normally POST this payload to an API endpoint
        # requests.post("https://metrics.yourcompany.com/ingest", json=payload)

if __name__ == "__main__":
    try:
        publisher = MetricsPublisher()
        publisher.analyze_and_publish()
    except Exception as e:
        print(f"Failed to publish metrics: {e}")
