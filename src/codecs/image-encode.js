/**
 * image-encode.js — 統一中間層 { width, height, data: RGBA } → PNG / JPEG Blob。
 *
 * 職責包含：
 *  - 最長邊上限縮放（resizeQuality:'high'，需求 9.6.4）
 *  - JPEG 的不透明背景填色（需求 9.6.3，預設白色，絕不讓透明區變黑）
 *  - 編碼後改寫解析度中繼資料（需求 9.4）
 */

import { createSurface } from '../core/surface.js';
import { applyDpi } from '../core/metadata.js';
import { imageOutputPixels } from '../core/resolution.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';

export const MIME = { png: 'image/png', jpeg: 'image/jpeg' };

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {{format:'png'|'jpeg', quality?:number, dpi:number, background?:string,
 *          maxEdge?:number|null, limits?:{maxDimension:number,maxArea:number}}} opts
 * @returns {Promise<{blob:Blob, width:number, height:number}>}
 */
export async function encodeImage(image, opts) {
  const format = opts.format;
  const mime = MIME[format];
  if (!mime) throw new AppError(ErrorCode.PATH_UNSUPPORTED, `unknown output format ${format}`);

  const out = imageOutputPixels({ width: image.width, height: image.height }, opts.maxEdge);
  if (opts.limits) {
    const { maxDimension, maxArea } = opts.limits;
    if (out.width > maxDimension || out.height > maxDimension || out.width * out.height > maxArea) {
      throw new AppError(ErrorCode.CANVAS_LIMIT, `${out.width}x${out.height} exceeds probed canvas limits`);
    }
  }

  let bmp = null;
  let surface = null;
  try {
    const src = new ImageData(image.data, image.width, image.height);

    // 需要縮放時優先用 createImageBitmap 的 resizeQuality:'high'
    if (out.scaled) {
      try {
        bmp = await createImageBitmap(src, {
          resizeWidth: out.width,
          resizeHeight: out.height,
          resizeQuality: 'high',
        });
      } catch {
        bmp = await createImageBitmap(src); // 由 drawImage 做高品質縮放（非最近鄰）
      }
    } else {
      bmp = await createImageBitmap(src);
    }

    surface = createSurface(out.width, out.height, { alpha: format === 'png' });
    const ctx = surface.ctx;

    // JPEG 沒有 alpha 通道：先鋪不透明底色再繪製（不可直接 putImageData）
    if (format === 'jpeg') {
      ctx.fillStyle = opts.background || '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, out.width, out.height);

    const quality = format === 'jpeg'
      ? Math.min(1, Math.max(0.01, (opts.quality == null ? 85 : opts.quality) / 100))
      : undefined;
    const blob = await surface.toBlob(mime, quality);
    if (!blob || blob.size === 0) throw new AppError(ErrorCode.ENCODE_FAILED, 'empty blob');

    // canvas 產出的解析度中繼資料固定是 96 dpi（或缺漏），一律改寫成使用者設定值
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const fixed = applyDpi(bytes, format, opts.dpi);
    return { blob: new Blob([fixed], { type: mime }), width: out.width, height: out.height };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw toAppError(e, ErrorCode.ENCODE_FAILED);
  } finally {
    if (bmp) bmp.close();
    if (surface) surface.release();
  }
}

/** 產生縮圖（給檔案清單用），固定 PNG、不寫解析度中繼資料。 */
export async function encodeThumbnail(image, maxEdge = 96) {
  const out = imageOutputPixels({ width: image.width, height: image.height }, maxEdge);
  let bmp = null;
  let surface = null;
  try {
    const src = new ImageData(image.data, image.width, image.height);
    try {
      bmp = await createImageBitmap(src, { resizeWidth: out.width, resizeHeight: out.height, resizeQuality: 'medium' });
    } catch {
      bmp = await createImageBitmap(src);
    }
    surface = createSurface(out.width, out.height);
    surface.ctx.imageSmoothingQuality = 'high';
    surface.ctx.drawImage(bmp, 0, 0, out.width, out.height);
    return await surface.toBlob('image/png');
  } catch {
    return null; // 縮圖失敗不影響轉換
  } finally {
    if (bmp) bmp.close();
    if (surface) surface.release();
  }
}
