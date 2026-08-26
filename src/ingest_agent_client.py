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
HEALTH_TIMEOUT_SEC = 1.5
# Public moq-zixi-gcp :8090 is down (2026-08-26). Never open a socket — a
# blackholed SYN hung jobs past health timeouts. Encode and playback stay.
ZIXI_PUBLIC_INGEST_AGENT_HOST = "35.222.33.58"


def skipped_zixi_public_agent_reason(*, host: str = "", base_url: str = "") -> str:
    parsed = (host or urlparse(base_url or "").hostname or "").strip()
    if parsed != ZIXI_PUBLIC_INGEST_AGENT_HOST:
        return ""
    return (
        f"Zixi ingest agent unreachable at {parsed}:8090 "
        "(public worker down; ingest VMAF skipped without contacting the host)"
    )


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


def _token_for_stack_host(host: str) -> Optional[str]:
    """Regional stacks use their own token env; never fall back to central."""
    if not host:
        return None
    from cloud_placement import ENCODE_HOSTS, host_relay_ip, host_web_ip, host_zixi_ip

    for encode_host in ENCODE_HOSTS:
        if encode_host.always_available:
            continue
        ips = {host_zixi_ip(encode_host), host_web_ip(encode_host), host_relay_ip(encode_host)}
        ips.discard("")
        if host in ips:
            return os.environ.get(f"{encode_host.env_prefix}_INGEST_AGENT_TOKEN", "").strip()
    return None


def resolve_agent_token(explicit_token: str = "", *, host: str = "") -> str:
    if explicit_token.strip():
        return explicit_token.strip()
    stacked = _token_for_stack_host(host)
    if stacked is not None:
        return stacked
    return os.environ.get("INGEST_AGENT_TOKEN", "").strip()


def resolve_ingest_agent(
    endpoint_url: str = "",
    *,
    agent_url: str = "",
    recording_dir: str = "",
    agent_port: int = DEFAULT_AGENT_PORT,
    agent_token: str = "",
) -> Optional[IngestAgentConfig]:
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

    token = resolve_agent_token(agent_token, host=host)
    if not token:
        return None

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


def _preset_needs_moq_recorder(preset_id: str = "", endpoint_url: str = "") -> bool:
    if preset_id:
        from destinations import PRESET_BY_ID

        preset = PRESET_BY_ID.get(preset_id)
        if preset is not None:
            return (preset.protocol or "").lower() == "moq"
    url = (endpoint_url or "").lower()
    return "moq-relay" in url or "/moq" in url


def vmaf_availability_for_endpoint(
    endpoint_url: str = "",
    *,
    preset_id: str = "",
    agent_url: str = "",
    recording_dir: str = "",
) -> tuple[bool, str]:
    """Whether ingest VMAF can actually run for this destination.

    Token-configured is not enough for MoQ: the worker must also have
    ``openmoq-fmp4-record``. Missing that binary is how comparison CSVs
    end up with a blank quality column after the UI offered the checkbox.
    """
    if not agent_url and preset_id:
        from destinations import ingest_agent_url_for_preset

        agent_url = ingest_agent_url_for_preset(preset_id)
    if not recording_dir and preset_id:
        from destinations import recording_dir_for_preset

        recording_dir = recording_dir_for_preset(preset_id)
    config = resolve_ingest_agent(
        endpoint_url,
        agent_url=agent_url,
        recording_dir=recording_dir,
    )
    if config is None:
        return False, "VMAF is not configured for this destination on the server"
    skip = skipped_zixi_public_agent_reason(host=config.host, base_url=config.base_url)
    if skip:
        return False, skip
    try:
        health = IngestAgentClient(config).health()
    except RuntimeError as exc:
        host = config.host or urlparse(config.base_url).hostname or "ingest-agent"
        if _preset_needs_moq_recorder(preset_id, endpoint_url):
            return False, f"MoQ ingest VMAF cannot reach the ingest worker ({exc})"
        return False, f"Zixi ingest agent unreachable at {host}:8090 ({exc})"
    if not _preset_needs_moq_recorder(preset_id, endpoint_url):
        return True, ""
    if health.get("moq_recorder_available"):
        return True, ""
    return False, (
        "MoQ ingest VMAF needs openmoq-fmp4-record on the ingest worker "
        "(post-relay subscribe scoring). WebRTC/WHIP and encoder VMAF do not "
        "use this recorder."
    )


def vmaf_available_for_endpoint(
    endpoint_url: str = "",
    *,
    preset_id: str = "",
    agent_url: str = "",
    recording_dir: str = "",
) -> bool:
    available, _reason = vmaf_availability_for_endpoint(
        endpoint_url,
        preset_id=preset_id,
        agent_url=agent_url,
        recording_dir=recording_dir,
    )
    return available


class IngestAgentClient:
    def __init__(self, config: IngestAgentConfig):
        self._config = config

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[dict] = None,
        timeout: float = 60,
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

        skip = skipped_zixi_public_agent_reason(
            host=self._config.host, base_url=self._config.base_url
        )
        if skip:
            raise RuntimeError(skip)
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except TimeoutError as exc:
            raise RuntimeError(f"Ingest agent unreachable at {url}: timed out") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(detail)
                message = payload.get("detail", detail)
            except json.JSONDecodeError:
                message = detail or exc.reason
            if isinstance(message, str) and message.startswith("{") and '"detail"' in message:
                try:
                    nested = json.loads(message)
                    if isinstance(nested.get("detail"), str):
                        message = nested["detail"]
                except json.JSONDecodeError:
                    pass
            raise RuntimeError(message) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Ingest agent unreachable at {url}: {exc.reason}") from exc

    def health(self) -> dict:
        skip = skipped_zixi_public_agent_reason(
            host=self._config.host, base_url=self._config.base_url
        )
        if skip:
            raise RuntimeError(skip)
        url = f"{self._config.base_url}/api/v1/health"
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=HEALTH_TIMEOUT_SEC) as response:
                return json.loads(response.read().decode("utf-8"))
        except TimeoutError as exc:
            raise RuntimeError("Ingest agent health check failed: timed out") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Ingest agent health check failed: {exc.reason}") from exc

    def host_metrics(self) -> dict:
        # Sample loops call this every ~1s; do not block on a dead agent.
        return self._request("GET", "/api/v1/host/metrics", timeout=2)

    def mediamtx_metrics_text(self) -> Optional[str]:
        try:
            payload = self._request("GET", "/api/v1/mediamtx/metrics", timeout=1)
        except Exception:
            return None
        body = payload.get("body") if isinstance(payload, dict) else None
        return str(body) if body else None

    def mediamtx_path_text(self, path_name: str) -> Optional[str]:
        safe = "".join(ch for ch in (path_name or "") if ch.isalnum() or ch in {"_", "-"})
        if not safe:
            return None
        try:
            payload = self._request("GET", f"/api/v1/mediamtx/paths/{safe}", timeout=1)
        except Exception:
            return None
        body = payload.get("body") if isinstance(payload, dict) else None
        return str(body) if body else None

    def zixi_input_stats_text(self, func: str, input_id: str) -> Optional[str]:
        from urllib.parse import quote

        safe_func = quote(func or "", safe="")
        safe_id = quote(input_id or "", safe="")
        if not safe_func or not safe_id:
            return None
        try:
            payload = self._request(
                "GET",
                f"/api/v1/zixi/input-stats?func={safe_func}&id={safe_id}",
                timeout=1,
            )
        except Exception:
            return None
        body = payload.get("body") if isinstance(payload, dict) else None
        return str(body) if body else None

    def upload_reference(self, job_id: str, media_path: str) -> None:
        filename = Path(media_path).name
        with open(media_path, "rb") as handle:
            self.upload_reference_bytes(job_id, handle.read(), filename)

    def upload_reference_bytes(self, job_id: str, file_bytes: bytes, filename: str) -> None:
        boundary = f"----moqboundary{int(time.time() * 1000)}"
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        safe_name = Path(filename).name or "reference.bin"

        body = b"".join([
            f"--{boundary}\r\n".encode(),
            (
                f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode(),
            file_bytes,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ])

        skip = skipped_zixi_public_agent_reason(
            host=self._config.host, base_url=self._config.base_url
        )
        if skip:
            raise RuntimeError(skip)
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
        http_ts_url: str = "",
    ) -> RemoteVmafResult:
        # Agent scores in a background thread and returns immediately. A
        # blocking 240s POST idle-timed-out while libvmaf still ran
        # (`Ingest agent unreachable … timed out` on Zixi 2026-08-26).
        payload = self._request(
            "POST",
            f"/api/v1/jobs/{job_id}/vmaf",
            body={
                "start_epoch": start_epoch,
                "end_epoch": end_epoch,
                "recording_dir": self._config.recording_dir,
                "http_ts_url": http_ts_url,
            },
            timeout=20,
        )
        deadline = time.time() + 210
        while time.time() < deadline:
            status = str(payload.get("status") or "")
            if status == "completed":
                return RemoteVmafResult(
                    vmaf_score=float(payload["vmaf_score"]),
                    psnr_db=float(payload["psnr_db"]) if payload.get("psnr_db") is not None else None,
                    ssim=float(payload["ssim"]) if payload.get("ssim") is not None else None,
                    distorted_path=payload.get("distorted_path", ""),
                    reference_path=payload.get("reference_path", ""),
                    log_path=payload.get("log_path", ""),
                )
            if status == "failed":
                return RemoteVmafResult(error=payload.get("error") or "VMAF computation failed")
            time.sleep(3)
            payload = self._request("GET", f"/api/v1/jobs/{job_id}", timeout=10)
        return RemoteVmafResult(
            error="Ingest VMAF still computing after 210s (libvmaf cap is 180s on the agent)",
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
        cert_sha256: str = "",
        video_track: str = "",
    ) -> dict:
        return self._request(
            "POST",
            f"/api/v1/jobs/{job_id}/recording/start",
            body={
                "namespace": namespace,
                "duration_sec": duration_sec,
                "relay_url": relay_url,
                "recording_dir": self._config.recording_dir,
                "cert_sha256": cert_sha256,
                "video_track": video_track,
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

    def start_http_ts_capture(
        self,
        job_id: str,
        *,
        url: str,
        duration_sec: int,
    ) -> dict:
        return self._request(
            "POST",
            f"/api/v1/jobs/{job_id}/http-ts-capture/start",
            body={"url": url, "duration_sec": duration_sec},
            timeout=30,
        )

    def stop_http_ts_capture(self, job_id: str) -> dict:
        return self._request(
            "POST",
            f"/api/v1/jobs/{job_id}/http-ts-capture/stop",
            timeout=30,
        )
