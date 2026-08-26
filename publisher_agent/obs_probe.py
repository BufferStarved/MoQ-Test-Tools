"""Detect OBS WebSocket and the OpenMOQ plugin on this laptop."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from publisher_agent.obs_websocket import ObsWebsocketError, obs_request_sync


def plugin_search_paths() -> List[Path]:
    home = Path.home()
    return [
        home / "Library/Application Support/obs-studio/plugins/obs-moq.plugin",
        home / "Library/Application Support/obs-studio/plugins/obs-moq.so",
        home / "Library/Application Support/obs-studio/plugins/obs-moq",
        home / ".config/obs-studio/plugins/obs-moq",
        Path("/usr/lib/x86_64-linux-gnu/obs-plugins/obs-moq.so"),
        Path("/usr/lib/obs-plugins/obs-moq.so"),
        Path("/Applications/OBS.app/Contents/PlugIns/obs-moq.plugin"),
    ]


def find_openmoq_plugin() -> Optional[str]:
    extra = (os.environ.get("OBS_OPENMOQ_PLUGIN") or "").strip()
    if extra and Path(extra).exists():
        return extra
    for path in plugin_search_paths():
        if path.exists():
            return str(path)
    return None


def probe_obs() -> Dict[str, Any]:
    plugin = find_openmoq_plugin()
    detail = "OBS WebSocket not reachable on ws://127.0.0.1:4455"
    websocket_ok = False
    try:
        obs_request_sync("GetVersion")
        websocket_ok = True
        detail = (
            "OpenMOQ plugin found"
            if plugin
            else "OBS WebSocket is up, but openmoq-plugin was not found on disk"
        )
    except ObsWebsocketError as exc:
        detail = str(exc)
    except Exception as exc:  # noqa: BLE001
        detail = str(exc)
    return {
        "obs_websocket": websocket_ok,
        "obs_plugin": bool(plugin),
        "obs_plugin_path": plugin or "",
        "obs_detail": detail,
    }
