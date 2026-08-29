#!/usr/bin/env bash
# Fast local gate: Python regressions + frontend typecheck + frontend unit scripts.
# Does not hit live ingest. East live matrix:
#   STACK=east DURATION=18 python3 scripts/e2e_ingest_matrix_test.py
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -x "$ROOT/.venv/bin/python3" ]]; then
  PYTHON="$ROOT/.venv/bin/python3"
elif [[ -x "$ROOT/venv/bin/python3" ]]; then
  PYTHON="$ROOT/venv/bin/python3"
else
  PYTHON="python3"
fi
export PYTHONPATH="$ROOT/src:$ROOT/web/api${PYTHONPATH:+:$PYTHONPATH}"

"$PYTHON" -m unittest \
  tests.test_ffmpeg_sigterm_exit \
  tests.test_east_ffmpeg_regressions \
  tests.test_browser_moq_api_gates \
  tests.test_local_publisher_api_gates \
  tests.test_mediamtx_loopback_and_whip_audio \
  tests.test_mediamtx_stats \
  tests.test_job_manager_preview_gate \
  tests.test_playback_merge \
  tests.test_latency_budget \
  tests.test_startup_budget \
  tests.test_startup_publisher \
  tests.test_startup_player \
  tests.test_metric_honesty \
  tests.test_qa_metric_audit_verdict \
  tests.test_rtmp_startup \
  tests.test_vod_assets \
  tests.test_bbb_deploy_and_whep_import \
  tests.test_cloud_placement \
  tests.test_cloud_encode_slots \
  tests.test_comparison_encode_hub \
  tests.test_moq_preview_ready_grace \
  tests.test_moq_preview \
  tests.test_moq_publish_announce \
  tests.test_encoder_metrics_fixes \
  tests.test_live_sample_payload \
  tests.test_moqx_stats \
  tests.test_zixi_stats \
  tests.test_http_ts_put_gate \
  tests.test_e2e_ingest_matrix_gates \
  tests.test_avfoundation_modes \
  tests.test_device_webcam \
  tests.test_webcam_broker \
  tests.test_build_info \
  tests.test_empty_result_csv \
  tests.test_cmaf_per_track \
  tests.test_csv_comparable_metrics \
  tests.test_encode_lag_tracker \
  tests.test_encode_profile_hls \
  tests.test_endpoint_probe \
  tests.test_ffmpeg_whip_preflight \
  tests.test_host_cpu_tracker \
  tests.test_launch_local_publisher \
  tests.test_llhls_packager_transit \
  tests.test_moq_d18_canary \
  tests.test_moq_gop_latency \
  tests.test_moq_pipe_eio \
  tests.test_moq_probe \
  tests.test_moq_recorder_tracks \
  tests.test_moq_relay_certs \
  tests.test_obs_openmoq_encoder \
  tests.test_picoquic_qlog \
  tests.test_publisher_api_guard \
  tests.test_publisher_hub \
  tests.test_publisher_protocol \
  tests.test_quality_metrics \
  tests.test_result_detail_json \
  tests.test_source_protocol_matrix \
  tests.test_srt_latency_floor \
  tests.test_upload_latency \
  tests.test_vmaf_annex_b \
  tests.test_vmaf_availability \
  tests.test_webcam_vmaf_reference \
  tests.test_zixi_error_concealment \
  tests.test_zixi_hls_heal \
  tests.test_zixi_hls_health \
  tests.test_zixi_ingest_vmaf_capture \
  tests.test_zixi_ts_offset \
  tests.test_zixi_upload_ts_offset_wiring \
  -q

# Frontend typecheck. `vite build` never runs tsc, so this is the only gate that
# catches type regressions before they ship — a dropped import once reached prod
# as a ReferenceError. Baseline is 0 errors; any error fails the run.
FRONTEND="$ROOT/web/frontend"
if [[ ! -x "$FRONTEND/node_modules/.bin/tsc" ]]; then
  echo "run-regression: FAIL frontend typecheck unavailable (run: cd web/frontend && npm install)" >&2
  exit 1
fi
(cd "$FRONTEND" && npm run --silent typecheck)

# Headed comparison 29/30 bugs already had *.test.ts coverage that this
# gate never ran. Source scanners (unit-*.mjs) cannot replay a CSV.
(
  cd "$FRONTEND"
  tests=()
  while IFS= read -r f; do
    tests+=("$f")
  done < <(find src -name '*.test.ts' ! -path '*/vendor/*' | sort)
  if [[ ${#tests[@]} -eq 0 ]]; then
    echo "run-regression: FAIL no frontend *.test.ts" >&2
    exit 1
  fi
  node --experimental-strip-types --test "${tests[@]}"
)

for script in "$ROOT"/web/frontend/scripts/unit-*.mjs; do
  node "$script"
done
node --test "$ROOT/tools/openmoq-recorder/record-policy.test.mjs"
