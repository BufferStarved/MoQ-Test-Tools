import os
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse


@dataclass(frozen=True)
class IngestHostConfig:
    host: str
    ssh_user: str
    ssh_key_path: str
    ssh_port: int
    recording_dir: str
    remote_work_dir: str


def host_from_endpoint(endpoint_url: str) -> Optional[str]:
    parsed = urlparse(endpoint_url)
    return parsed.hostname or None


def resolve_ssh_key() -> str:
    for candidate in (
        os.environ.get("INGEST_SSH_KEY", ""),
        os.path.expanduser("~/.ssh/id_ed25519"),
        os.path.expanduser("~/.ssh/id_rsa"),
    ):
        if candidate and os.path.isfile(candidate):
            return candidate
    return os.path.expanduser("~/.ssh/id_ed25519")


def resolve_ingest_host(endpoint_url: str, recording_dir: str = "") -> Optional[IngestHostConfig]:
    host = host_from_endpoint(endpoint_url)
    if not host or host in {"127.0.0.1", "localhost"}:
        return None

    return IngestHostConfig(
        host=host,
        ssh_user=os.environ.get("INGEST_SSH_USER", "ubuntu"),
        ssh_key_path=resolve_ssh_key(),
        ssh_port=int(os.environ.get("INGEST_SSH_PORT", "22")),
        recording_dir=recording_dir or os.environ.get(
            "INGEST_RECORDING_DIR",
            "/opt/zixi_broadcaster-linux64/recordings",
        ),
        remote_work_dir=os.environ.get("INGEST_VMAF_WORK_DIR", "/tmp/moq-vmaf"),
    )
