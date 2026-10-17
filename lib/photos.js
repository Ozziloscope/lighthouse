// Profile photos. The browser shrinks a photo to a small square JPEG before uploading it; here we check
// that what arrived really is a JPEG of a sensible size, and remove any metadata it carries
// (camera details, GPS location, comments) before it is stored.
const { MAX_PHOTO_BYTES } = require("./constants");
const { STATUS, fail } = require("./http");

const JPEG_START = [0xff, 0xd8];
const MARKER_PREFIX = 0xff;
const START_OF_SCAN = 0xda;
const END_OF_IMAGE = 0xd9;
const APP1_TO_APP15 = { first: 0xe1, last: 0xef };    // removed: EXIF, GPS, XMP, ICC and vendor data
const COMMENT = 0xfe;                                 // removed
const RESTART_MARKERS = { first: 0xd0, last: 0xd7 };  // markers with no length field
const STANDALONE_MARKER = 0x01;
const START_OF_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2]); // baseline, extended and progressive images
const LENGTH_FIELD_BYTES = 2;

const DATA_URL_PREFIX = /^data:image\/jpeg;base64,/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// Accepts "data:image/jpeg;base64,..." (what a browser canvas produces) or plain base64.
function decodeUpload(input) {
  if (typeof input !== "string" || !input) fail(STATUS.badRequest, "Choose a photo to upload.");
  const base64 = input.replace(DATA_URL_PREFIX, "");
  if (!BASE64_PATTERN.test(base64)) fail(STATUS.badRequest, "The photo didn't upload correctly. Try again.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_PHOTO_BYTES) fail(STATUS.badRequest, `That photo is too large (the limit is ${Math.round(MAX_PHOTO_BYTES / 1024)} KB after shrinking).`);
  return bytes;
}

// Walks the JPEG's segments, keeps the image data and drops metadata segments.
function stripJpegMetadata(bytes) {
  const notAJpeg = () => fail(STATUS.badRequest, "Photos must be JPEG images. Try a different photo.");
  if (bytes[0] !== JPEG_START[0] || bytes[1] !== JPEG_START[1]) notAJpeg();
  const kept = [bytes.subarray(0, JPEG_START.length)];
  let position = JPEG_START.length, sawImageFrame = false;

  while (position < bytes.length) {
    if (bytes[position] !== MARKER_PREFIX) notAJpeg();
    const marker = bytes[position + 1];
    if (marker === MARKER_PREFIX) { position += 1; continue; } // padding
    if (marker === END_OF_IMAGE) { kept.push(bytes.subarray(position, position + 2)); break; }
    const hasNoLength = marker === STANDALONE_MARKER || (marker >= RESTART_MARKERS.first && marker <= RESTART_MARKERS.last);
    if (hasNoLength) { kept.push(bytes.subarray(position, position + 2)); position += 2; continue; }

    const segmentLength = bytes.readUInt16BE(position + 2);
    if (segmentLength < LENGTH_FIELD_BYTES) notAJpeg();
    const segmentEnd = position + 2 + segmentLength;
    if (segmentEnd > bytes.length) notAJpeg();
    if (START_OF_FRAME_MARKERS.has(marker)) sawImageFrame = true;

    if (marker === START_OF_SCAN) {
      // Everything from here to the end is compressed image data (plus the end marker): keep it as is.
      kept.push(bytes.subarray(position));
      break;
    }
    const isMetadata = marker === COMMENT || (marker >= APP1_TO_APP15.first && marker <= APP1_TO_APP15.last);
    if (!isMetadata) kept.push(bytes.subarray(position, segmentEnd));
    position = segmentEnd;
  }
  if (!sawImageFrame) notAJpeg();
  return Buffer.concat(kept);
}

const preparePhoto = (input) => stripJpegMetadata(decodeUpload(input));

module.exports = { preparePhoto };
