--[[
  Extra OBS outputs for the moq-test-tools OBS encoder path.

  OpenMOQ occupies Settings → Stream (service id "MOQ"). This script starts
  SRT (ffmpeg_mpegts) and RTMP outputs that share the stream encoder so one
  OBS encode can race SRT + RTMP + MoQ.

  OBS → Tools → Scripts → + → this file.
  The helper writes ~/.moq-test-tools/obs-outputs.json when a run starts.
]]

local obs = obslua
local outputs = {}
local last_gen = ""

local function outputs_path()
  local home = os.getenv("HOME") or os.getenv("USERPROFILE") or ""
  return home .. "/.moq-test-tools/obs-outputs.json"
end

local function read_file(path)
  local handle = io.open(path, "r")
  if handle == nil then
    return nil
  end
  local data = handle:read("*a")
  handle:close()
  return data
end

local function parse_json_string(body, key)
  -- Tiny extractor: "key": "value"
  local pattern = '"' .. key .. '"%s*:%s*"([^"]*)"'
  return body:match(pattern)
end

local function parse_active(body)
  return body:match('"active"%s*:%s*true') ~= nil
end

local function parse_generation(body)
  return parse_json_string(body, "generation") or body
end

local function stop_output(name)
  local output = outputs[name]
  if output ~= nil then
    obs.obs_output_stop(output)
    obs.obs_output_release(output)
    outputs[name] = nil
  end
end

local function share_stream_encoders(output)
  local stream = obs.obs_frontend_get_streaming_output()
  if stream == nil then
    return
  end
  local venc = obs.obs_output_get_video_encoder(stream)
  local aenc = obs.obs_output_get_audio_encoder(stream, 0)
  if venc ~= nil then
    obs.obs_output_set_video_encoder(output, venc)
  end
  if aenc ~= nil then
    obs.obs_output_set_audio_encoder(output, aenc, 0)
  end
  obs.obs_output_release(stream)
end

local function start_srt(url)
  stop_output("srt")
  if url == nil or url == "" then
    return
  end
  local settings = obs.obs_data_create()
  obs.obs_data_set_string(settings, "url", url)
  obs.obs_data_set_string(settings, "muxer", "mpegts")
  local output = obs.obs_output_create("ffmpeg_mpegts_muxer", "moq-bench-srt", settings, nil)
  obs.obs_data_release(settings)
  if output == nil then
    obs.script_log(obs.LOG_WARNING, "[moq-bench] failed to create SRT output")
    return
  end
  share_stream_encoders(output)
  if not obs.obs_output_start(output) then
    obs.script_log(obs.LOG_WARNING, "[moq-bench] SRT output failed to start")
    obs.obs_output_release(output)
    return
  end
  outputs["srt"] = output
  obs.script_log(obs.LOG_INFO, "[moq-bench] SRT output started")
end

local function start_rtmp(url)
  stop_output("rtmp")
  if url == nil or url == "" then
    return
  end
  local server, key = url:match("^(rtmp[s]?://.+)/([^/]+)$")
  if server == nil then
    server = url
    key = "live"
  end
  local settings = obs.obs_data_create()
  obs.obs_data_set_string(settings, "server", server)
  obs.obs_data_set_string(settings, "key", key)
  local output = obs.obs_output_create("rtmp_output", "moq-bench-rtmp", settings, nil)
  obs.obs_data_release(settings)
  if output == nil then
    obs.script_log(obs.LOG_WARNING, "[moq-bench] failed to create RTMP output")
    return
  end
  share_stream_encoders(output)
  if not obs.obs_output_start(output) then
    obs.script_log(obs.LOG_WARNING, "[moq-bench] RTMP output failed to start")
    obs.obs_output_release(output)
    return
  end
  outputs["rtmp"] = output
  obs.script_log(obs.LOG_INFO, "[moq-bench] RTMP output started")
end

local function apply_spec()
  local body = read_file(outputs_path())
  if body == nil then
    return
  end
  local generation = parse_generation(body)
  if generation == last_gen then
    return
  end
  last_gen = generation
  if not parse_active(body) then
    stop_output("srt")
    stop_output("rtmp")
    obs.script_log(obs.LOG_INFO, "[moq-bench] extra outputs stopped")
    return
  end
  start_srt(parse_json_string(body, "srt_url"))
  start_rtmp(parse_json_string(body, "rtmp_url"))
end

function script_description()
  return "moq-test-tools extra SRT/RTMP outputs while Stream uses the OpenMOQ plugin."
end

function script_load(settings)
  obs.timer_add(apply_spec, 500)
end

function script_unload()
  obs.timer_remove(apply_spec)
  stop_output("srt")
  stop_output("rtmp")
end
