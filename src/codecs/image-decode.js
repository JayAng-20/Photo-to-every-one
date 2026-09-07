/**
 * image-decode.js — PNG / JPEG 解碼成統一中間層 { width, height, data: RGBA }。
 *
 * 需求 6.3：所有解碼器一律輸出同一種型別。
 */

import { createSurface } from '../core/surface.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';

/**
 * 只取尺寸，不解碼整張（給檔案清單用）。
 * @param {Blob} blob
 */
export async function probeImageSize(blob) {
  let bmp = null;
  try {
    bmp = await createImageBitmap(blob);
    return { width: bmp.width, height: bmp.height };
  } catch (e) {
    throw toAppError(new AppError(ErrorCode.CORRUPT_FILE, e));
  } finally {
    if (bmp) bmp.close();
  }
}

/**
 * @param {Uint8Array|ArrayBuffer|Blob} input
 * @param {string} mime
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>}
 */
export async function decodeImage(input, mime) {
  const blob = input instanceof Blob
    ? input
    : new Blob([input instanceof Uint8Array ? input : new Uint8Array(input)], { type: mime });

  let bmp = null;
  let surface = null;
  try {
    // imageOrientation:'from-image' 讓瀏覽器套用 JPEG 的 EXIF 方向。
    // 舊瀏覽器不認 options 就退回預設行為。
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(blob);
    }
    const { width, height } = bmp;
    surface = createSurface(width, height, { readback: true });
    surface.ctx.drawImage(bmp, 0, 0);
    const imageData = surface.ctx.getImageData(0, 0, width, height);
    return { width, height, data: imageData.data };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw toAppError(new AppError(ErrorCode.CORRUPT_FILE, e));
  } finally {
    if (bmp) bmp.close();
    if (surface) surface.release();
  }
}
