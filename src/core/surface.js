/**
 * surface.js — 對 OffscreenCanvas 與 DOM canvas 的薄封裝。
 *
 * 需求第 14 節：OffscreenCanvas 在部分瀏覽器的 Worker 內支援程度不同，
 * 必須有回退到主執行緒 canvas 的路徑。Worker 內沒有 document，
 * 所以在 Worker 裡只能用 OffscreenCanvas；主執行緒兩者都可以。
 */

import { AppError, ErrorCode } from './errors.js';

export const hasOffscreen = typeof OffscreenCanvas === 'function'
  && typeof OffscreenCanvas.prototype.convertToBlob === 'function';

export const isWorker = typeof document === 'undefined';

export function createSurface(width, height, opts = {}) {
  if (width < 1 || height < 1) throw new AppError(ErrorCode.ENCODE_FAILED, 'invalid surface size');
  let canvas;
  if (hasOffscreen && (isWorker || opts.preferOffscreen !== false)) {
    canvas = new OffscreenCanvas(width, height);
  } else if (!isWorker) {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } else {
    throw new AppError(ErrorCode.BROWSER_UNSUPPORTED, 'no OffscreenCanvas in worker');
  }
  const ctx = canvas.getContext('2d', { alpha: opts.alpha !== false, willReadFrequently: !!opts.readback });
  if (!ctx) throw new AppError(ErrorCode.ENCODE_FAILED, 'getContext(2d) returned null');
  if (canvas.width !== width || canvas.height !== height) {
    throw new AppError(ErrorCode.CANVAS_LIMIT, `requested ${width}x${height}, got ${canvas.width}x${canvas.height}`);
  }
  return {
    canvas,
    ctx,
    width,
    height,
    async toBlob(type, quality) {
      if (typeof canvas.convertToBlob === 'function') {
        return canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
      }
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new AppError(ErrorCode.ENCODE_FAILED, 'toBlob returned null'))),
          type,
          quality
        );
      });
    },
    release() {
      try { canvas.width = 1; canvas.height = 1; } catch { /* 忽略 */ }
    },
  };
}

/** 依 resizeQuality:'high' 縮放；瀏覽器不支援 options 時回退到高品質 drawImage。 */
export async function bitmapFrom(source, resize) {
  if (resize && (resize.width !== undefined)) {
    try {
      return await createImageBitmap(source, {
        resizeWidth: resize.width,
        resizeHeight: resize.height,
        resizeQuality: 'high',
      });
    } catch {
      // 落到下面的一般路徑，由呼叫端用 drawImage 縮放
    }
  }
  return createImageBitmap(source);
}
