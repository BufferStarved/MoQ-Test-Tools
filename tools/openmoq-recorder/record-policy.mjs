/**
 * Subscribe / FETCH policy for openmoq-fmp4-record.
 *
 * Same-session SUBSCRIBE retries after 0x10 or a 5s silence reuse the
 * track alias while the prior generation is still terminating (draft-18
 * §11.1). Linode :14433 then records 0 bytes even after the publisher
 * announced. Reconnect (fresh aliases) instead; CMAF uses AbsoluteStart
 * so the one-shot catalog / retained objects are retrievable.
 */

export const CATALOG_TRACK = "catalog";
export const CMAF_VIDEO_TRACK = "vide_1";
export const LOC_VIDEO_TRACK = "video";

export function isLocTrack(trackName) {
  return trackName === "video" || trackName === "audio";
}

export function isCmafMediaTrack(trackName) {
  return typeof trackName === "string" && /^(vide|soun)_\d+$/.test(trackName);
}

export function subscribeFilterForTrack(trackName) {
  if (trackName === CATALOG_TRACK || isCmafMediaTrack(trackName)) {
    return { type: "AbsoluteStart", startGroup: 0n, startObject: 0n };
  }
  return { type: "LargestObject" };
}

/** Cloud CMAF before LOC so a missing `video` track does not consume an alias. */
export function orderedTrackNames(tracks) {
  const names = [...new Set((tracks || []).filter(Boolean))];
  const rank = (name) => {
    if (name === CATALOG_TRACK) return 0;
    if (name === CMAF_VIDEO_TRACK) return 1;
    if (isCmafMediaTrack(name)) return 2;
    if (name === LOC_VIDEO_TRACK) return 3;
    return 4;
  };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function wantsCatalogSubscribe(tracks) {
  return (tracks || []).some((name) => isCmafMediaTrack(name));
}

export function isRetryableSubscribeError(err) {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes("no such namespace")
    || msg.includes("no such track")
    || msg.includes("unknown track")
    || msg.includes("upstream subscribe failed")
    || msg.includes("publisher not ready")
  );
}

export function isAliasReuseError(err) {
  const msg = String(err?.message ?? err);
  return (
    /§\s*11\.1/.test(msg)
    || /11\.1/.test(msg)
    || /reuse refused/i.test(msg)
    || /duplicate_track_alias/i.test(msg)
    || /still guarded by a terminating/i.test(msg)
  );
}

/** Never send a second SUBSCRIBE on a session that already rejected or tore down. */
export function shouldRetrySubscribeOnSameSession(_err) {
  return false;
}

export function shouldResubscribeAfterSilence() {
  return false;
}

export function reconnectBackoffMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(2000, 400 * (2 ** Math.min(n, 3)));
}

/** One track per session. Rotate only after an unknown-track miss, not 0x10 namespace. */
export function nextTrackForReconnect(tracks, lastTried, err) {
  const names = orderedTrackNames(tracks);
  if (!names.length) {
    return "";
  }
  const msg = String(err?.message ?? err).toLowerCase();
  if (!lastTried || msg.includes("no such namespace")) {
    return names[0];
  }
  const idx = names.indexOf(lastTried);
  if (idx >= 0 && idx + 1 < names.length) {
    return names[idx + 1];
  }
  return names[0];
}

/**
 * Resolve CMAF init bytes (base64) from an MSF catalog object.
 * libmoq ships initDataList + initRef; older catalogs used track.initData.
 */
export function catalogInitB64(catalog, trackName) {
  if (!catalog || typeof catalog !== "object") {
    return "";
  }
  const wanted = String(trackName || CMAF_VIDEO_TRACK);
  const tracks = Array.isArray(catalog.tracks) ? catalog.tracks : [];
  const track = tracks.find((entry) => entry && entry.name === wanted) || {};
  if (typeof track.initData === "string" && track.initData.length > 0) {
    return track.initData;
  }
  const list = Array.isArray(catalog.initDataList) ? catalog.initDataList : [];
  const ref = typeof track.initRef === "string" && track.initRef ? track.initRef : wanted;
  const hit = list.find((entry) => entry && (entry.id === ref || entry.id === wanted));
  if (hit && typeof hit.data === "string") {
    return hit.data;
  }
  return "";
}

export function parseCatalogObject(payload) {
  if (!payload) {
    return null;
  }
  try {
    const text = typeof payload === "string"
      ? payload
      : new TextDecoder().decode(payload);
    return JSON.parse(text);
  } catch {
    return null;
  }
}
