/**
 * paths.js — 所有靜態資產的位置。
 *
 * 全部用 import.meta.url 相對解析，網站可以掛在任何子路徑下（GitHub Pages 會多一層
 * 子路徑）；也保證不會有任何指向外部網域的請求（需求第 13 節）。
 */
const rel = (p) => new URL(p, import.meta.url).href;

/**
 * A/B 切換開關：PDF.js 的 cmaps 與 standard_fonts 要用打包檔還是逐檔載入。
 *
 *   true （預設）— 用 public/pdfjs/cmaps.pack 與 standard_fonts.pack，
 *                  兩個請求取代 185 個；部署時不需要上傳原始的兩個目錄。
 *   false        — 走 PDF.js 原本的逐檔 fetch（cmaps/ 與 standard_fonts/ 必須存在）。
 *
 * 這個開關存在的理由有二：一是用來做「打包前後渲染結果完全相同」的對照驗證，
 * 二是萬一打包檔出問題時的即時回退點。切成 false 之後不需要改任何其他程式碼，
 * 但要確認 public/pdfjs/cmaps/ 與 standard_fonts/ 兩個目錄有部署上去。
 */
export const USE_PACKED_PDFJS_ASSETS = true;

/**
 * 執行期的實際值。預設等於上面的 USE_PACKED_PDFJS_ASSETS，
 * 只有 A/B 對照驗證與緊急回退會去改它。
 */
let usePacked = USE_PACKED_PDFJS_ASSETS;

/** 目前是否使用打包資產。pdf-decode.js 每次 openPdf 都會問一次。 */
export const isUsingPackedPdfjsAssets = () => usePacked;

/**
 * 執行期切換打包／逐檔模式。
 *
 * 用途一：第 6.2 節的「同一頁、同一份程式、切換前後渲染結果必須完全相同」對照驗證。
 * 用途二：線上出事時的即時回退 —— 在 console 執行
 *         `(await import('./src/core/paths.js')).setUsePackedPdfjsAssets(false)`
 *         之後新開的 PDF 就會改走逐檔載入（前提是那兩個目錄有部署）。
 * 永久回退請直接把上面的 USE_PACKED_PDFJS_ASSETS 改成 false 並重跑
 * `python3 tools/gen-precache.py --unpacked`。
 */
export function setUsePackedPdfjsAssets(value) {
  usePacked = !!value;
  return usePacked;
}

export const ASSETS = {
  pdfWorker: rel('../../public/pdfjs/pdf.worker.min.mjs'),

  // 逐檔模式用的目錄（USE_PACKED_PDFJS_ASSETS = false 時才會被 PDF.js 直接 fetch）
  cmaps: rel('../../public/pdfjs/cmaps/'),
  standardFonts: rel('../../public/pdfjs/standard_fonts/'),

  // 打包模式用的單一檔案
  cmapsPack: rel('../../public/pdfjs/cmaps.pack'),
  standardFontsPack: rel('../../public/pdfjs/standard_fonts.pack'),

  // 這兩個一律維持逐檔：wasm 走 BinaryDataFactory 轉發，icc 由 pdf.worker 自己同步抓
  pdfWasm: rel('../../public/pdfjs/wasm/'),
  pdfIcc: rel('../../public/pdfjs/iccs/'),

  libheifWasm: rel('../../public/wasm/libheif.wasm'),
};
