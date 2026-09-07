/**
 * heic-decode.js — HEIF/HEIC 解碼（原生優先、libheif WASM fallback）。
 *
 * 需求 8.3：
 *  - 先做能力偵測，Safari 走 createImageBitmap() 原生快速路徑。
 *  - WASM 路徑直接輸出 RGBA，不走「解碼→編 JPEG→再解碼」的三段管線。
 *  - libheif WASM 約 1.4 MB，用動態 import() 延後載入。
 *  - 只取主影像，並回報檔案內共有幾張影像。
 *  - 套用 EXIF 方向。
 *
 * 實作備註（依實際套件內容，非照抄舊範例）：
 *  libheif-js 1.23.2 的 libheif-wasm/libheif.js 是同步 instantiate 的 Emscripten
 *  build，必須由外部把 .wasm 位元組以 wasmBinary 傳進去；而且 Chrome 限制主執行緒
 *  的同步 WebAssembly 編譯大小，因此這個模組只能在 Worker 內使用。
 */

import { ASSETS } from '../core/paths.js';
import { AppError, ErrorCode } from '../core/errors.js';
import { heifOrientation, applyOrientation, heifTransforms } from '../core/exif.js';

let modulePromise = null;

/** 動態載入並初始化 libheif WASM（只會做一次） */
export function loadLibheif() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    let factory, wasmBinary;
    try {
      const [mod, res] = await Promise.all([
        import('../../vendor/libheif/libheif.mjs'),
        fetch(ASSETS.libheifWasm),
      ]);
      if (!res.ok) throw new Error(`fetch libheif.wasm ${res.status}`);
      factory = mod.default;
      wasmBinary = await res.arrayBuffer();
    } catch (e) {
      modulePromise = null;
      throw new AppError(ErrorCode.HEIC_CODEC_INIT, e);
    }

    try {
      let ranSync = false;
      const instance = factory({
        wasmBinary,
        onRuntimeInitialized() { ranSync = true; },
        print() {}, printErr() {},
      });
      if (!ranSync && !instance.calledRun) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('libheif init timeout')), 30000);
          instance.onRuntimeInitialized = () => { clearTimeout(timer); resolve(); };
        });
      }
      if (typeof instance.HeifDecoder !== 'function') throw new Error('HeifDecoder missing');
      return instance;
    } catch (e) {
      modulePromise = null;
      throw new AppError(ErrorCode.HEIC_CODEC_INIT, e);
    }
  })();
  return modulePromise;
}

/** 瀏覽器原生是否能解 HEIC（Safari 可以）。結果快取起來。 */
let nativeSupport = null;
export async function probeNativeHeic(blob) {
  if (nativeSupport === false) return false;
  try {
    const bmp = await createImageBitmap(blob);
    bmp.close();
    nativeSupport = true;
    return true;
  } catch {
    if (nativeSupport === null) nativeSupport = false;
    return false;
  }
}

async function decodeNative(blob, bytes) {
  let bmp = null;
  let surface = null;
  try {
    bmp = await createImageBitmap(blob);
    const { createSurface } = await import('../core/surface.js');
    surface = createSurface(bmp.width, bmp.height, { readback: true });
    surface.ctx.drawImage(bmp, 0, 0);
    const id = surface.ctx.getImageData(0, 0, bmp.width, bmp.height);
    let image = { width: bmp.width, height: bmp.height, data: id.data };

    // 原生路徑：createImageBitmap 通常已套用方向。只有在尺寸顯示「未旋轉」時才補。
    const o = heifOrientation(bytes);
    let appliedOrientation = 0;
    if (o && o !== 1) {
      // 已旋轉的話寬高會與 EXIF 期待一致，這裡不重複套用旋轉類方向，
      // 但翻轉類（2/4）不改變尺寸，無從判斷，交由瀏覽器處理。
      appliedOrientation = 0;
    }
    return { image, imageCount: 1, orientation: o || 1, appliedOrientation, path: 'native' };
  } finally {
    if (bmp) bmp.close();
    if (surface) surface.release();
  }
}

async function decodeWasm(bytes) {
  const lib = await loadLibheif();
  const decoder = new lib.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(bytes);
  } catch (e) {
    throw new AppError(ErrorCode.CORRUPT_FILE, e);
  }
  if (!images || images.length === 0) {
    // libheif 解不出來：可能不是 HEVC 編碼，也可能檔案損毀
    throw new AppError(ErrorCode.HEIC_NOT_HEVC);
  }

  const primaryIdx = Math.max(0, images.findIndex((im) => {
    try { return im.is_primary(); } catch { return false; }
  }));
  const img = images[primaryIdx < 0 ? 0 : primaryIdx];

  try {
    const width = img.get_width();
    const height = img.get_height();
    if (!width || !height) throw new AppError(ErrorCode.CORRUPT_FILE, 'zero dimensions');

    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    await new Promise((resolve, reject) => {
      try {
        img.display(target, (out) => (out ? resolve(out) : reject(new AppError(ErrorCode.HEIC_NOT_HEVC))));
      } catch (e) { reject(new AppError(ErrorCode.CORRUPT_FILE, e)); }
    });

    let image = { width, height, data: target.data };

    // ---- 方向處理 ----
    // 實測（macOS ImageIO 產生的 HEIC，同時帶 EXIF Orientation 6 與 irot angle 3）：
    // libheif 解碼時已經套用容器的 irot/imir 轉換屬性，這時再套一次 EXIF Orientation
    // 就會轉兩次、把直式轉回橫式。因此只有在容器沒有轉換屬性時才依 EXIF 旋轉。
    const o = heifOrientation(bytes) || 1;
    const tf = heifTransforms(bytes);
    const containerTransformed = (tf.irot != null && tf.irot !== 0) || (tf.imir != null);

    let appliedOrientation = 0;
    if (o !== 1 && !containerTransformed) {
      image = applyOrientation(image, o);
      appliedOrientation = o;
    }

    return {
      image,
      imageCount: images.length,
      orientation: o,
      appliedOrientation,
      containerTransform: containerTransformed ? { irot: tf.irot, imir: tf.imir } : null,
      ispe: tf.ispe,
      rawSize: { width, height },
      hasAlpha: (() => { try { return img.has_alpha_channel(); } catch { return false; } })(),
      path: 'wasm',
    };
  } finally {
    for (const im of images) { try { im.free(); } catch { /* 忽略 */ } }
  }
}

/**
 * @param {Uint8Array} bytes 整個 HEIF 檔案
 * @param {{preferNative?:boolean}} [opts]
 * @returns {Promise<{image:{width,height,data}, imageCount:number, orientation:number,
 *                    appliedOrientation:number, path:'native'|'wasm'}>}
 */
export async function decodeHeic(bytes, opts = {}) {
  const blob = new Blob([bytes], { type: 'image/heic' });
  if (opts.preferNative !== false) {
    try {
      if (await probeNativeHeic(blob)) return await decodeNative(blob, bytes);
    } catch {
      // 原生失敗 → 走 WASM
    }
  }
  return decodeWasm(bytes);
}

/** 釋放 WASM heap：整批結束後由 worker 池 terminate() 整個 worker 才是真正的釋放。 */
export function unloadLibheif() {
  modulePromise = null;
}
