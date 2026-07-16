import os
import secrets


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


WORK_DIR = _env("INGEST_AGENT_WORK_DIR", "/var/lib/moq-ingest-agent")
RECORDING_DIR = _env("INGEST_RECORDING_DIR", "/opt/zixi_broadcaster-linux64")
API_TOKEN = _env("INGEST_AGENT_TOKEN") or _env("MOQ_INGEST_AGENT_TOKEN")
HOST = _env("INGEST_AGENT_HOST", "0.0.0.0")
PORT = int(_env("INGEST_AGENT_PORT", "8090"))
FFMPEG_BIN = _env("INGEST_FFMPEG_BIN", "/usr/local/bin/ffmpeg")
MOQ_RECORDER_BIN = _env(
    "MOQ_RECORDER_BIN",
    "/opt/moq-test-tools/tools/openmoq-recorder/bin/openmoq-fmp4-record",
)
MOQ_RELAY_URL = _env("MOQ_RELAY_URL", "https://127.0.0.1:4433/moq-relay")
MOQ_RELAY_CERT_SHA256 = _env("MOQ_RELAY_CERT_SHA256", "")

if not API_TOKEN:
    API_TOKEN = secrets.token_urlsafe(32)
