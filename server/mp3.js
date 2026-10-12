// Tiny MPEG audio frame parser. The broadcaster sends whole frames only, so a
// listener joining mid-stream always starts on a clean frame boundary.

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function readHeader(buf, i) {
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (buf[i + 1] >> 1) & 3; // 1 = Layer III
  const brIdx = buf[i + 2] >> 4;
  const srIdx = (buf[i + 2] >> 2) & 3;
  const padding = (buf[i + 2] >> 1) & 1;
  if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const sampleRate = SAMPLE_RATES[version][srIdx];
  const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[brIdx] * 1000;
  const samples = version === 3 ? 1152 : 576;
  const size = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return { size, duration: samples / sampleRate };
}

function id3v2Length(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  return 10 + size + (buf[5] & 0x10 ? 10 : 0);
}

/** Split an MP3 buffer into frames: [{ data: Buffer, duration: seconds }]. */
export function parseFrames(buf) {
  const frames = [];
  let i = id3v2Length(buf);
  while (i + 4 <= buf.length) {
    const h = readHeader(buf, i);
    // Require the following frame to also line up so random 0xFF bytes in
    // leftover junk can't knock us out of sync.
    if (!h || i + h.size > buf.length || (i + h.size + 4 <= buf.length && !readHeader(buf, i + h.size))) {
      i++;
      continue;
    }
    frames.push({ data: buf.subarray(i, i + h.size), duration: h.duration });
    i += h.size;
  }
  return frames;
}

/** A single silent MPEG1 Layer III frame (44.1kHz stereo) at the given CBR bitrate. */
export function silentFrame(kbps) {
  let idx = BITRATES_V1.indexOf(kbps);
  if (idx <= 0) idx = BITRATES_V1.indexOf(128);
  const size = Math.floor((144 * BITRATES_V1[idx] * 1000) / 44100);
  const frame = Buffer.alloc(size, 0);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG1, Layer III, no CRC
  frame[2] = (idx << 4) | (0 << 2); // bitrate, 44.1kHz, no padding
  frame[3] = 0x40; // joint stereo
  // All-zero side info = zero-length granules = digital silence.
  return { data: frame, duration: 1152 / 44100 };
}
