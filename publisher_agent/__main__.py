"""python -m publisher_agent — connect a laptop publisher to the orchestrator API."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from publisher_agent.agent import PublisherAgent, default_ws_url  # noqa: E402
from publisher_agent.deps import check_all, ensure_tool_path, required_ok  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MoQ Test Tools local publisher agent")
    parser.add_argument(
        "--api",
        default=os.environ.get("LOCAL_PUBLISHER_API", "http://127.0.0.1:8000"),
        help="API base URL (default http://127.0.0.1:8000)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("LOCAL_PUBLISHER_TOKEN", "dev-local-publisher"),
        help="Shared token (must match API LOCAL_PUBLISHER_TOKEN)",
    )
    parser.add_argument(
        "--agent-id",
        default=os.environ.get("LOCAL_PUBLISHER_AGENT_ID", ""),
        help="Optional stable agent id",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Print dependency status and exit",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    deps = check_all(ROOT_DIR)
    ensure_tool_path(deps)
    print("Publisher agent dependency check:")
    for dep in deps:
        mark = "OK " if dep.ok else "MISS"
        print(f"  [{mark}] {dep.name:18} {dep.path or dep.detail}")
        if not dep.ok and dep.install_hint:
            print(f"         hint: {dep.install_hint}")

    if args.check_only:
        return 0 if required_ok(deps) else 1

    if not required_ok(deps):
        print("\nffmpeg with libx264 is required. Fix the MISS lines above, then retry.")
        return 1

    agent = PublisherAgent(
        api_ws_url=default_ws_url(args.api),
        token=args.token,
        agent_id=args.agent_id,
    )
    print(f"\nConnecting to {args.api} as local publisher…")
    print("Leave this running while you start comparisons with Publisher = This machine.\n")
    try:
        asyncio.run(agent.run_forever())
    except KeyboardInterrupt:
        print("\nPublisher agent stopped.")
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
