import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { AsyncSemaphore } from "../core/async-semaphore.ts";

/** Safe bounds enforced before decoding any image into Photon WASM RGBA memory. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 25_000_000;
const IMAGE_DECODE_CONCURRENCY = 2;

type ImageInspectionResult =
  | { ok: true; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp"; width: number; height: number }
  | { ok: false; reason: string };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWithBytes = (buf: Uint8Array, prefix: readonly number[]) => buf.length >= prefix.length && prefix.every((b, i) => buf[i] === b);
const startsWithAscii = (buf: Uint8Array, offset: number, text: string) => {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (buf[offset + i] !== text.charCodeAt(i)) return false;
  return true;
};
const u16LE = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u16BE = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u32BE = (b: Uint8Array, o: number) => ((b[o] ?? 0) * 0x1000000) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0);
const u32LE = (b: Uint8Array, o: number) => (b[o] ?? 0) + ((b[o + 1] ?? 0) << 8) + ((b[o + 2] ?? 0) << 16) + ((b[o + 3] ?? 0) * 0x1000000);
const i32LE = (b: Uint8Array, o: number) => ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24));

function isAnimatedPngBytes(bytes: Uint8Array): boolean {
  let offset = PNG_SIG.length;
  while (offset + 8 <= bytes.length) {
    const chunkLen = u32BE(bytes, offset);
    if (startsWithAscii(bytes, offset + 4, "acTL")) return true;
    if (startsWithAscii(bytes, offset + 4, "IDAT")) return false;
    const next = offset + 8 + chunkLen + 4;
    if (next <= offset || next > bytes.length) return false;
    offset = next;
  }
  return false;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset++]!;
    // Standalone markers without length: TEM (0x01), RST0-7 (0xD0-0xD7), SOI (0xD8), EOI (0xD9).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    // Start of scan: no SOF follows.
    if (marker === 0xda) return undefined;
    if (offset + 2 > bytes.length) return undefined;
    const segmentLen = u16BE(bytes, offset);
    if (segmentLen < 2 || offset + segmentLen > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segmentLen < 7) return undefined;
      return { height: u16BE(bytes, offset + 3), width: u16BE(bytes, offset + 5) };
    }
    offset += segmentLen;
  }
  return undefined;
}

/**
 * Inspect raw image headers without decoding pixels (fail-closed): rejects unknown/animated formats and images whose
 * declared dimensions or total pixels exceed the safe pre-decode bounds before handing bytes to Photon WASM.
 */
export function inspectImageBeforeDecode(bytes: Uint8Array,
  limits: { maxDimension?: number; maxPixels?: number } = {}): ImageInspectionResult {
  const maxDimension = limits.maxDimension ?? MAX_IMAGE_DIMENSION;
  const maxPixels = limits.maxPixels ?? MAX_IMAGE_PIXELS;
  let mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | undefined;
  let dims: { width: number; height: number } | undefined;

  if (startsWithBytes(bytes, PNG_SIG)) {
    if (bytes.length < 24 || u32BE(bytes, 8) !== 13 || !startsWithAscii(bytes, 12, "IHDR") || isAnimatedPngBytes(bytes)) {
      return { ok: false, reason: "unsupported_png" };
    }
    mimeType = "image/png";
    dims = { width: u32BE(bytes, 16), height: u32BE(bytes, 20) };
  } else if (startsWithBytes(bytes, [0xff, 0xd8, 0xff]) && bytes[3] !== 0xf7) {
    mimeType = "image/jpeg";
    dims = jpegDimensions(bytes);
  } else if (startsWithAscii(bytes, 0, "GIF87a") || startsWithAscii(bytes, 0, "GIF89a")) {
    mimeType = "image/gif";
    dims = bytes.length >= 10 ? { width: u16LE(bytes, 6), height: u16LE(bytes, 8) } : undefined;
  } else if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP") && bytes.length >= 30) {
    mimeType = "image/webp";
    if (startsWithAscii(bytes, 12, "VP8 ")) {
      dims = { width: u16LE(bytes, 26) & 0x3fff, height: u16LE(bytes, 28) & 0x3fff };
    } else if (startsWithAscii(bytes, 12, "VP8L")) {
      const bits = u32LE(bytes, 21);
      dims = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (startsWithAscii(bytes, 12, "VP8X")) {
      const u24 = (o: number) => u16LE(bytes, o) + ((bytes[o + 2] ?? 0) << 16);
      dims = { width: u24(24) + 1, height: u24(27) + 1 };
    }
  } else if (startsWithAscii(bytes, 0, "BM") && bytes.length >= 26) {
    mimeType = "image/bmp";
    const dibSize = u32LE(bytes, 14);
    if (dibSize === 12) dims = { width: u16LE(bytes, 18), height: u16LE(bytes, 20) };
    else if (dibSize >= 40 && dibSize <= 124 && bytes.length >= 26) dims = { width: Math.abs(i32LE(bytes, 18)), height: Math.abs(i32LE(bytes, 22)) };
  }

  if (!mimeType || !dims) return { ok: false, reason: "unknown_or_invalid_header" };
  if (dims.width < 1 || dims.height < 1) return { ok: false, reason: "invalid_dimensions" };
  if (dims.width > maxDimension || dims.height > maxDimension) return { ok: false, reason: "dimension_limit" };
  if (dims.width * dims.height > maxPixels) return { ok: false, reason: "pixel_limit" };
  return { ok: true, mimeType, width: dims.width, height: dims.height };
}

/**
 * Wrap an `ImageProcessor` (Photon) so EVERY decoding entry point (`read`, `fit-images`, direct-chat image inlining)
 * shares the exact same pre-decode byte/dimension/pixel guard and process-wide concurrency bound.
 */
export function guardImageProcessor(inner: ImageProcessor, options: {
  maxBytes?: number;
  maxDimension?: number;
  maxPixels?: number;
  concurrency?: number;
} = {}): ImageProcessor {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const maxDimension = options.maxDimension ?? MAX_IMAGE_DIMENSION;
  const maxPixels = options.maxPixels ?? MAX_IMAGE_PIXELS;
  const slots = new AsyncSemaphore(options.concurrency ?? IMAGE_DECODE_CONCURRENCY);
  return {
    async prepare(bytes, _mimeType, limits) {
      if (bytes.byteLength > maxBytes) return undefined;
      const inspected = inspectImageBeforeDecode(bytes, { maxDimension, maxPixels });
      if (!inspected.ok) return undefined;
      const release = await slots.acquire();
      try {
        return await inner.prepare(bytes, inspected.mimeType, limits);
      } finally {
        release();
      }
    },
  };
}
