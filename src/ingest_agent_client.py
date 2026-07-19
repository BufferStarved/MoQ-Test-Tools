import json
import logging
import mimetypes
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from ingest_host import host_from_endpoint

logger = logging.getLogger("MoQ-SRT-Bench")

DEFAULT_AGENT_PORT = int(os.environ.get("INGEST_AGENT_PORT", "8090"))


@dataclass(frozen=True)
class IngestAgentConfig:
    base_url: str
    token: str
    recording_dir: str
    host: str


@dataclass
class RemoteVmafResult:
    vmaf_score: Optional[float] = None
    psnr_db: Optional[float] = None
    ssim: Optional[float] = None
    distorted_path: str = ""
    reference_path: str = ""
    log_path: str = ""
    error: Optional[str] = None


def resolve_agent_token(explicit_token: str = "") -> str:
    if explicit_token.strip():
        return explicit_token.strip()
    return os.environ.get("INGEST_AGENT_TOKEN", "").strip()


def resolve_ingest_agent(
    endpoint_url: str = "",
    *,
    agent_url: str = "",
    recording_dir: str = "",
    agent_port: int = DEFAULT_AGENT_PORT,
    agent_token: str = "",
) -> Optional[IngestAgentConfig]:
    token = resolve_agent_token(agent_token)
    if not token:
        return None

    explicit_base = (agent_url or os.environ.get("INGEST_AGENT_BASE_URL", "")).strip().rstrip("/")
    if explicit_base:
        base_url = explicit_base
        host = urlparse(base_url).hostname or ""
    else:
        host = host_from_endpoint(endpoint_url)
        if not host or host in {"127.0.0.1", "localhost"}:
            return None
        scheme = (
            "https"
            if os.environ.get("INGEST_AGENT_USE_HTTPS", "").lower() in {"1", "true", "yes"}
            else "http"
        )
        base_url = f"{scheme}://{host}:{agent_port}"

    return IngestAgentConfig(
        base_url=base_url,
        token=token,
        recording_dir=recording_dir or os.environ.get(
            "INGEST_RECORDING_DIR",
            "/opt/zixi_broadcaster-linux64",
        ),
        host=host,
    )


def agent_health_url(config: IngestAgentConfig) -> str:
    return f"{config.base_url}/api/v1/health"


def vmaf_available_for_endpoint(
    endpoint_url: str = "",
    *,
    preset_id: str = "",
    agent_url: str = "",
    recording_dir: str = "",
) -> bool:
    if not agent_url and preset_id:
        from destinations import ingest_agent_url_for_preset

        agent_url = ingest_agent_url_for_preset(preset_id)
    if not recording_dir and preset_id:
        from destinations import recording_dir_for_preset

        recording_dir = recording_dir_for_preset(preset_id)
    return resolve_ingest_agent(
        endpoint_url,
        agent_url=agent_url,
        recording_dir=recording_dir,
    ) is not None


class IngestAgentClient:
    def __init__(self, config: IngestAgentConfig):
        self._config = config

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[dict] = None,
        timeout: int = 60,
    ) -> dict:
        url = f"{self._config.base_url}{path}"
        data = None
        headers = {
            "Authorization": f"Bearer {self._config.token}",
            "Accept": "application/json",
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(detail)
                message = payload.get("detail", detail)
            except json.JSONDecodeError:
                message = detail or exc.reason
            raise RuntimeError(message) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Ingest agent unreachable at {url}: {exc.reason}") from exc

    def health(self) -> dict:
        url = f"{self._config.base_url}/api/v1/health"
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Ingest agent health check failed: {exc.reason}") from exc

    def host_metrics(self) -> dict:
        # Sample loops call this every ~1s; do not block on a dead agent.
        return self._request("GET", "/api/v1/host/metrics", timeout=2)

    def upload_reference(self, job_id: str, media_path: str) -> None:
        boundary = f"----moqboundary{int(time.time() * 1000)}"
        filename = Path(media_path).name
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

        with open(media_path, "rb") as handle:
            file_bytes = handle.read()

        body = b"".join([
            f"--{boundary}\r\n".encode(),
            (
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode(),
            file_bytes,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ])

        url = f"{self._config.base_url}/api/v1/jobs/{job_id}/reference"
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {self._config.token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(detail or exc.reason) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Reference upload failed: {exc.reason}") from exc

    def compute_vmaf(
        self,
        job_id: str,
        start_epoch: float,
        end_epoch: float,
    ) -> RemoteVmafResult:
        payload = self._request(
            "POST",
            f"/api/v1/jobs/{job_id}/vmaf",
            body={
                "start_epoch": start_epoch,
                "end_epoch": end_epoch,
                "recording_dir": self._config.recording_dir,
            },
            timeout=900,
        )
        if payload.get("status") != "completed":
            return RemoteVmafResult(error=payload.get("error") or "VMAF computation failed")
        return RemoteVmafResult(
            vmaf_score=float(payload["vmaf_score"]),
            psnr_db=float(payload["psnr_db"]) if payload.get("psnr_db") is not None else None,
            ssim=float(payload["ssim"]) if payload.get("ssim") is not None else None,
            distorted_path=payload.get("distorted_path", ""),
            reference_path=payload.get("reference_path", ""),
            log_path=payload.get("log_path", ""),
        )

    def compute_media_health(
        self,
        job_id: str,
        *,
        start_epoch: float = 0.0,
        end_epoch: float = 0.0,
        output_path: str = "",
    ) -> dict:
        return self._request(
            "POST",
            f"/api/v1/jobs/{job_id}/media-health",
            body={
                "start_epoch": start_epoch,
                "end_epoch": end_epoch,
                "recording_dir": self._config.recording_dir,
                "output_path": output_path,
            },
            timeout=120,
        )

    def start_moq_recording(
        self,
        job_id: str,
        *,
        namespace: str,
        duration_sec: int,
        relay_url: str = "",
    ) -> dict:
        return self._request(
            "POST",
            f"/api/v1/jobs/{job_id}/recording/start",
            body={
                "namespace": namespace,
                "duration_sec": duration_sec,
                "relay_url": relay_url,
                "recording_dir": self._config.recording_dir,
            },
            timeout=30,
        )

    def recording_status(self, job_id: str) -> Optional[dict]:
        try:
            return self._request("GET", f"/api/v1/jobs/{job_id}/recording", timeout=30)
        except RuntimeError as exc:
            if "404" in str(exc) or "not found" in str(exc).lower():
                return None
            raise

    def stop_moq_recording(self, job_id: str) -> dict:
        return self._request(
            "POST",
            f"/api/v1/jobs/{job_id}/recording/stop",
            timeout=60,
        )
