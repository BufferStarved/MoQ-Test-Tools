import assert from "node:assert/strict";
import { test } from "node:test";

import { hlsLiveSyncDurationCount, playlistDepth } from "./hlsPlaylist.ts";

test("1-deep Fast HLS asks hls.js for one segment, not two", () => {
  const oneSeg = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nchunk0.ts\n";
  assert.equal(playlistDepth(oneSeg), 1);
  assert.equal(hlsLiveSyncDurationCount(1, 2), 1);
  assert.equal(hlsLiveSyncDurationCount(3, 2), 2);
});
