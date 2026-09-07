/**
 * pdf-decode.js — 用 PDF.js 逐頁渲染成統一中間層 { width, height, data: RGBA }。
 *
 * 需求 8.1：
 *  - scale = 解析度(dpi) / 72
 *  - 支援頁面範圍：全部 / 單頁 / 範圍 / 清單
 *  - 一頁渲染完就立刻釋放該頁 canvas 與 ImageData
 *  - 加密 PDF 直接標記失敗，不嘗試破解
 *  - worker、cmaps、standard_fonts 全部自行部署，初始化時指定路徑
 *
 * 這個模組在主執行緒執行：PDF.js 自己會開一個 worker 做解析，主執行緒只負責
 * 點陣化，且每頁之間都會讓出事件迴圈，所以介面不會凍結。
 */

import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';
import { ASSETS, isUsingPackedPdfjsAssets } from '../core/paths.js';
import { PackedBinaryDataFactory } from './pdfjs-assets.js';
import { AppError, ErrorCode } from '../core/errors.js';
import { pdfRenderScale } from '../core/resolution.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = ASSETS.pdfWorker;

const DOC_OPTIONS = {
  // cMapUrl / standardFontDataUrl 兩個一律照舊傳入，即使在打包模式下也一樣：
  //  - cMapUrl 是逐檔模式的來源，留著才切得回去。
  //  - standardFontDataUrl 除了逐檔載入之外，PDF.js 還會用它組出系統字型替代用的
  //    @font-face `url(...)`（generateFont 內的 `url(${standardFontDataUrl}${path})`），
  //    那條路徑由瀏覽器直接抓，不經過 BinaryDataFactory。拿掉會讓未內嵌字型的 PDF
  //    少一層字型回退 —— 屬於使用者可見的行為改變，所以不能動。
  //    它實際引用的只有 4 個 LiberationSans-*.ttf，這 4 個必須維持真實檔案。
  cMapUrl: ASSETS.cmaps,          // 漏掉會讓含中日韓字元的 PDF 變空白或方框
  cMapPacked: true,
  standardFontDataUrl: ASSETS.standardFonts,
  wasmUrl: ASSETS.pdfWasm,
  iccUrl: ASSETS.pdfIcc,          // 不走 BinaryDataFactory，由 pdf.worker 自己同步抓
  isEvalSupported: false,
  // useSystemFonts 保留 PDF.js 的瀏覽器預設值：未內嵌字型時才有機會用系統字型替代
  disableAutoFetch: true,
  verbosity: 0,
};

/**
 * 打包模式下多帶一個 BinaryDataFactory。
 *
 * PDF.js 6.3.289 的公開擴充點：`getDocument({ BinaryDataFactory })`。
 * 只要傳自訂類別，PDF.js 內部的 `useWorkerFetch` 就會自動變成 false，
 * cmap / 標準字型 / wasm 的請求全部改走
 * `messageHandler.on("FetchBinaryData", t => binaryDataFactory.fetch(t))`。
 * 切回 false 時不傳這個參數，行為與改動前一模一樣。
 */
function docOptions() {
  return isUsingPackedPdfjsAssets()
    ? { ...DOC_OPTIONS, BinaryDataFactory: PackedBinaryDataFactory }
    : DOC_OPTIONS;
}

/**
 * 解析頁面範圍字串。
 * @param {string} spec 'all' / '3' / '1-3' / '1,3,5' / '1-3,7'
 * @param {number} total 總頁數
 * @returns {number[]} 1-based 頁碼，已排序去重
 */
export function parsePageRange(spec, total) {
  const s = String(spec == null ? '' : spec).trim();
  if (s === '' || s.toLowerCase() === 'all' || s === '全部') {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (!/^[0-9,\s-]+$/.test(s)) throw new AppError(ErrorCode.PAGE_RANGE_INVALID);
  const out = new Set();
  for (const partRaw of s.split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (!a || !b) throw new AppError(ErrorCode.PAGE_RANGE_INVALID);
      if (a > b) [a, b] = [b, a];
      if (a < 1 || b > total) {
        throw new AppError(ErrorCode.PAGE_RANGE_INVALID, null, `頁面範圍超出這個檔案的頁數（共 ${total} 頁）`);
      }
      for (let i = a; i <= b; i++) out.add(i);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new AppError(ErrorCode.PAGE_RANGE_INVALID);
    const n = parseInt(part, 10);
    if (n < 1 || n > total) {
      throw new AppError(ErrorCode.PAGE_RANGE_INVALID, null, `頁面範圍超出這個檔案的頁數（共 ${total} 頁）`);
    }
    out.add(n);
  }
  if (out.size === 0) throw new AppError(ErrorCode.PAGE_RANGE_INVALID);
  return [...out].sort((a, b) => a - b);
}

/**
 * 開啟 PDF。回傳的物件用完必須呼叫 destroy()。
 * @param {Uint8Array} bytes
 */
export async function openPdf(bytes) {
  // PDF.js 會接管（並可能 detach）傳進去的 buffer，所以給它一份副本
  const task = pdfjsLib.getDocument({ data: bytes.slice(), ...docOptions() });
  // 有密碼保護時不要跳出輸入框，直接讓 promise reject
  task.onPassword = (_updateCallback, _reason) => {
    task.destroy();
  };
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (e && (e.name === 'PasswordException' || e instanceof pdfjsLib.PasswordException)) {
      throw new AppError(ErrorCode.PDF_ENCRYPTED, e);
    }
    if (e && (e.name === 'InvalidPDFException' || e.name === 'MissingPDFException')) {
      throw new AppError(ErrorCode.CORRUPT_FILE, e);
    }
    throw new AppError(ErrorCode.CORRUPT_FILE, e);
  }

  return {
    numPages: doc.numPages,

    /** 頁面在 PDF 使用者空間的尺寸（pt），已套用頁面旋轉 */
    async pageSizePt(n) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const size = { width: vp.width, height: vp.height };
      page.cleanup();
      return size;
    },

    /**
     * 渲染一頁成 RGBA。渲染完立刻釋放 canvas。
     * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>}
     */
    async renderPage(n, dpi, limits) {
      const page = await doc.getPage(n);
      let canvas = null;
      try {
        const viewport = page.getViewport({ scale: pdfRenderScale(dpi) });
        const w = Math.max(1, Math.floor(viewport.width));
        const h = Math.max(1, Math.floor(viewport.height));
        if (limits && (w > limits.maxDimension || h > limits.maxDimension || w * h > limits.maxArea)) {
          throw new AppError(ErrorCode.CANVAS_LIMIT, `page ${n}: ${w}x${h}`);
        }
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        if (canvas.width !== w || canvas.height !== h) {
          throw new AppError(ErrorCode.CANVAS_LIMIT, `canvas clamped to ${canvas.width}x${canvas.height}`);
        }
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new AppError(ErrorCode.ENCODE_FAILED, 'no 2d context');
        // intent:'print' 有兩個好處：
        //  (1) PDF.js 只有在 display intent 才用 requestAnimationFrame 排程，
        //      分頁被切到背景時 rAF 不會觸發，渲染會永遠卡住；print intent 改用
        //      微任務排程，背景分頁也能完成。這點是實測出來的。
        //  (2) 轉檔輸出本來就該用列印外觀（annotation 的 print appearance）。
        await page.render({ canvas, viewport, background: '#ffffff', intent: 'print' }).promise;
        const id = ctx.getImageData(0, 0, w, h);
        return { width: w, height: h, data: id.data };
      } catch (e) {
        if (e instanceof AppError) throw e;
        if (e && /allocation|memory/i.test(e.message || '')) throw new AppError(ErrorCode.OUT_OF_MEMORY, e);
        throw new AppError(ErrorCode.DECODE_FAILED, e);
      } finally {
        page.cleanup();
        if (canvas) { canvas.width = 1; canvas.height = 1; }
      }
    },

    async destroy() {
      // PDF.js v6 的銷毀入口在 loading task 上（PDFDocumentProxy 沒有 destroy()），
      // 它會中止所有請求並關閉 pdf.worker。
      try { await task.destroy(); } catch { /* 忽略 */ }
    },
  };
}

/** 只讀頁數與第一頁尺寸（給檔案清單用），讀完就關掉。 */
export async function probePdf(bytes) {
  const pdf = await openPdf(bytes);
  try {
    const size = await pdf.pageSizePt(1);
    return { numPages: pdf.numPages, firstPageSizePt: size };
  } finally {
    await pdf.destroy();
  }
}
