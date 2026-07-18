// Copy-paste signaling: turns a WebRTC session description into a short
// shareable text code and back. No signaling server — the host and the guest
// exchange these codes over any channel they like (chat, email, carrier
// pigeon). The code is deflate-compressed (built-in CompressionStream) and
// base64url-encoded, wrapped in HRW1. / .HRW1 sentinels so stray whitespace
// from chat apps can be trimmed away.

const MAGIC = "HRW1";
const MAX_CODE = 64 * 1024;   // sanity cap on pasted codes

function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipe(bytes, TransformCtor, kind) {
  const stream = new Blob([bytes]).stream().pipeThrough(new TransformCtor(kind));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function deflate(bytes) {
  if (typeof CompressionStream === "undefined") return bytes;   // very old browser: plain
  return pipe(bytes, CompressionStream, "deflate-raw");
}
async function inflate(bytes) {
  if (typeof DecompressionStream === "undefined") return bytes;
  return pipe(bytes, DecompressionStream, "deflate-raw");
}

// desc: { type: "offer"|"answer", sdp: string } -> shareable code
export async function encodeSignal(desc) {
  const json = JSON.stringify({ y: desc.type, s: desc.sdp });
  const raw = new TextEncoder().encode(json);
  let packed, flag;
  if (typeof CompressionStream !== "undefined") { packed = await deflate(raw); flag = "c"; }
  else { packed = raw; flag = "p"; }
  return MAGIC + flag + "." + b64urlEncode(packed) + "." + MAGIC;
}

// shareable code -> { type, sdp } or null if it isn't a valid code
export async function decodeSignal(text) {
  if (typeof text !== "string" || text.length > MAX_CODE) return null;
  // tolerate surrounding chatter/whitespace: find the sentinel-wrapped payload
  const m = text.match(/HRW1([cp])\.([A-Za-z0-9_-]+)\.HRW1/);
  if (!m) return null;
  try {
    let bytes = b64urlDecode(m[2]);
    if (m[1] === "c") bytes = await inflate(bytes);
    if (bytes.length > MAX_CODE) return null;
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || typeof obj !== "object") return null;
    if (obj.y !== "offer" && obj.y !== "answer") return null;
    if (typeof obj.s !== "string" || obj.s.length > MAX_CODE) return null;
    // Shape-check the SDP enough to know it's an SDP and not something weird.
    if (!obj.s.startsWith("v=0")) return null;
    return { type: obj.y, sdp: obj.s };
  } catch {
    return null;
  }
}

// Resolves once ICE gathering completes (or after timeoutMs — whatever has
// gathered by then still works on most networks, it just has fewer candidates).
// The timeout leaves room for TURN relay allocation on slow links: relay
// candidates are the only route across strict-NAT pairs, so losing them to an
// eager cutoff would break exactly the users who need them.
export function gatherComplete(pc, timeoutMs = 6500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", check); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}
