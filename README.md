cat << 'EOF' > README.md
# MoQ vs SRT Upload Benchmark

A lightweight, asynchronous test suite for benchmarking the upload performance (CPU and Memory usage) of Media Over Quic (MOQ) live video streams against Secure Reliable Transport (SRT) live streams.

## Architecture
This tool uses Python to concurrently orchestrate multiple `ffmpeg` processes. It non-blockingly tracks hardware telemetry using `psutil`, logs data to a CSV, and includes a publisher script to parse and aggregate the results into a JSON payload for downstream ingestion.

*Note: As standard `ffmpeg` builds do not yet natively support `moq://` and `srt://` without custom compilation, this v1 utilizes `udp://` mocks to validate the metrics pipeline infrastructure.*

## Prerequisites
* Python 3.8+
* `ffmpeg` (Standard build)
* `nc` (Netcat, built into macOS/Linux)

## Setup
1. Clone the repository.
2. Create and activate a virtual environment:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
3. Install dependencies:
   `pip install -r requirements.txt`
4. Generate a dummy test video:
   `ffmpeg -f lavfi -i testsrc=duration=60:size=1280x720:rate=30 -f lavfi -i sine=frequency=1000:duration=60 -c:v libx264 -c:a aac dummy.mp4`

## Running the Benchmark
Because we are mocking the transport layer over UDP, you need to set up local listeners to catch the packets so `ffmpeg` does not crash.

**1. Start the Listeners (Separate Terminal Tabs)**
Terminal Tab 1 (SRT Mock):
`nc -ul 9000 > /dev/null`

Terminal Tab 2 (MOQ Mock):
`nc -ul 9001 > /dev/null`

**2. Execute the Test (Main Terminal Tab)**
Run a 30-second benchmark:
`python src/runner.py --media dummy.mp4 --duration 30`

## Analyzing the Results
Once the run is complete, raw telemetry is saved to the `results/` directory. To aggregate this data into a JSON summary (Average CPU/RAM usage per protocol), run:

`python src/publisher.py`
