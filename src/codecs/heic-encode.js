/**
 * heic-encode.js — Phase 2：輸出 HEIF/HEIC。
 *
 * 需求 5.3：沒有任何瀏覽器支援 canvas.toBlob('image/heic')。npm 上唯一現成的
 * 瀏覽器端方案是 elheif 0.1.0（libheif + libde265 + kvazaar 編成 WASM，MIT 包裝），
 * 其 jsEncodeImage(buf, width, height) 沒有品質參數。
 *
 * 獨立 spike 的實測結果（tools/heic-encode-spike.html）：
 *   - 輸出檔的 ftyp brand = heic，含 hvcC / ispe / pixi，結構正確
 *   - macOS sips 與 Quick Look（Apple ImageIO，與 elheif 完全獨立）都能正確開啟，
 *     尺寸與來源一致（512×384）
 *   - WASM 以 base64 內嵌在 1.47 MB 的 JS 內；初始化約 100 ms
 *   - 編碼速度約 0.76 秒／百萬像素（1600×1200 約 1.3 秒、3000×2000 約 4.6 秒）
 * 因此判定可行並啟用。已知限制寫在 LIMITATIONS，UI 必須如實顯示。
 */

import { AppError, ErrorCode } from '../core/errors.js';
import { imageOutputPixels } from '../core/resolution.js';
import { createSurface } from '../core/surface.js';

/** 由 M9 spike 的實測結果決定 */
export const ENABLED = true;

/** elheif 沒有品質參數，UI 必須隱藏品質控制項而不是放一個沒作用的滑桿 */
export const SUPPORTS_QUALITY = false;

/** elheif 沒有寫入解析度中繼資料的 API */
export const SUPPORTS_DPI_METADATA = false;

export const DISABLED_REASON = '目前瀏覽器環境無法輸出 HEIF/HEIC，建議改用 JPEG 或 PNG';

export const LIMITATIONS = 'HEIF/HEIC 由 elheif（libheif + kvazaar）在本機編碼：'
  + '沒有品質參數可調，也無法寫入解析度中繼資料，且速度較慢（約 0.8 秒／百萬像素）。';

let modPromise = null;

function loadElheif() {
  if (!modPromise) {
    modPromise = (async () => {
      const mod = await import('../../vendor/elheif/index.js');
      await mod.ensureInitialized();
      if (typeof mod.jsEncodeImage !== 'function') throw new Error('jsEncodeImage missing');
      return mod;
    })().catch((e) => {
      modPromise = null;
      throw new AppError(ErrorCode.HEIC_ENCODE_UNAVAILABLE, e);
    });
  }
  return modPromise;
}

/** 需要縮放時先用 createImageBitmap(resizeQuality:'high') 縮好再送去編碼 */
async function resized(image, target) {
  let bmp = null;
  let surface = null;
  try {
    const src = new ImageData(image.data, image.width, image.height);
    try {
      bmp = await createImageBitmap(src, {
        resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high',
      });
    } catch {
      bmp = await createImageBitmap(src);
    }
    surface = createSurface(target.width, target.height, { readback: true });
    surface.ctx.imageSmoothingQuality = 'high';
    surface.ctx.drawImage(bmp, 0, 0, target.width, target.height);
    const id = surface.ctx.getImageData(0, 0, target.width, target.height);
    return { width: target.width, height: target.height, data: id.data };
  } finally {
    if (bmp) bmp.close();
    if (surface) surface.release();
  }
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {{maxEdge?:number|null}} [opts]
 * @returns {Promise<{blob:Blob,width:number,height:number}>}
 */
export async function encodeHeic(image, opts = {}) {
  if (!ENABLED) throw new AppError(ErrorCode.HEIC_ENCODE_UNAVAILABLE, null, DISABLED_REASON);

  const target = imageOutputPixels({ width: image.width, height: image.height }, opts.maxEdge);
  const src = target.scaled ? await resized(image, target) : image;

  const mod = await loadElheif();
  const bytes = new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength);
  let res;
  try {
    res = mod.jsEncodeImage(bytes, src.width, src.height);
  } catch (e) {
    throw new AppError(ErrorCode.HEIC_ENCODE_UNAVAILABLE, e);
  }
  if (!res || res.err || !res.data || !res.data.length) {
    throw new AppError(ErrorCode.HEIC_ENCODE_UNAVAILABLE, res && res.err);
  }
  return {
    blob: new Blob([res.data], { type: 'image/heic' }),
    width: src.width,
    height: src.height,
  };
}
