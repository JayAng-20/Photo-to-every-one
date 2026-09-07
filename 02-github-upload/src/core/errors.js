/**
 * errors.js — 錯誤碼與使用者可讀訊息對照表。
 *
 * 規則（需求第 12 節）：任何情況下都不得把原始 JavaScript 例外直接顯示給使用者。
 * 原始訊息只寫進 console 供除錯，UI 一律顯示這裡的中文文案。
 */

export const ErrorCode = {
  UNKNOWN_FORMAT: 'UNKNOWN_FORMAT',
  AVIF_UNSUPPORTED: 'AVIF_UNSUPPORTED',
  CORRUPT_FILE: 'CORRUPT_FILE',
  PDF_ENCRYPTED: 'PDF_ENCRYPTED',
  HEIC_CODEC_INIT: 'HEIC_CODEC_INIT',
  HEIC_NOT_HEVC: 'HEIC_NOT_HEVC',
  PATH_UNSUPPORTED: 'PATH_UNSUPPORTED',
  RESOLUTION_INVALID: 'RESOLUTION_INVALID',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  BATCH_TOO_MANY: 'BATCH_TOO_MANY',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  BROWSER_UNSUPPORTED: 'BROWSER_UNSUPPORTED',
  CANVAS_LIMIT: 'CANVAS_LIMIT',
  PAGE_RANGE_INVALID: 'PAGE_RANGE_INVALID',
  ENCODE_FAILED: 'ENCODE_FAILED',
  DECODE_FAILED: 'DECODE_FAILED',
  HEIC_ENCODE_UNAVAILABLE: 'HEIC_ENCODE_UNAVAILABLE',
  CANCELLED: 'CANCELLED',
  WORKER_FAILED: 'WORKER_FAILED',
};

const MESSAGES = {
  [ErrorCode.UNKNOWN_FORMAT]: '無法辨識這個檔案的格式，目前只支援 PDF、PNG、JPEG、HEIF/HEIC',
  [ErrorCode.AVIF_UNSUPPORTED]: '這是 AVIF 檔案，目前尚未支援',
  [ErrorCode.CORRUPT_FILE]: '這個檔案已損毀或格式不完整，無法讀取',
  [ErrorCode.PDF_ENCRYPTED]: '這個 PDF 有密碼保護，目前無法處理',
  [ErrorCode.HEIC_CODEC_INIT]: 'HEIF/HEIC 解碼元件載入失敗，請重新整理頁面再試一次',
  [ErrorCode.HEIC_NOT_HEVC]: '這個 HEIF 檔案使用了目前不支援的編碼方式',
  [ErrorCode.PATH_UNSUPPORTED]: '目前不支援這個轉換組合',
  [ErrorCode.RESOLUTION_INVALID]: '請輸入 1 到 1200 之間的數值',
  [ErrorCode.OUT_OF_MEMORY]: '檔案太大，瀏覽器記憶體不足。建議降低解析度或分批處理',
  [ErrorCode.FILE_TOO_LARGE]: '單一檔案不能超過 100 MB',
  [ErrorCode.BATCH_TOO_MANY]: '一次最多只能加入 100 個檔案',
  [ErrorCode.BATCH_TOO_LARGE]: '這一批檔案的總大小不能超過 1 GB',
  [ErrorCode.BROWSER_UNSUPPORTED]: '你的瀏覽器不支援必要功能，建議改用最新版 Chrome、Edge、Safari 或 Firefox',
  [ErrorCode.CANVAS_LIMIT]: '這個設定產生的影像超出瀏覽器繪圖上限，請降低解析度',
  [ErrorCode.PAGE_RANGE_INVALID]: '頁面範圍格式不正確，請輸入像 1-3 或 1,3,5 這樣的格式',
  [ErrorCode.ENCODE_FAILED]: '輸出檔案時發生問題，請改用其他格式或降低解析度再試一次',
  [ErrorCode.DECODE_FAILED]: '讀取這個檔案的內容時失敗，檔案可能已損毀',
  [ErrorCode.HEIC_ENCODE_UNAVAILABLE]: '目前瀏覽器環境無法輸出 HEIF/HEIC，建議改用 JPEG 或 PNG',
  [ErrorCode.CANCELLED]: '已取消',
  [ErrorCode.WORKER_FAILED]: '背景處理程序異常結束，請重新整理頁面再試一次',
};

/** 應用程式內部統一的錯誤型別。message 永遠是可以直接顯示給使用者的中文。 */
export class AppError extends Error {
  constructor(code, detail = null, overrideMessage = null) {
    super(overrideMessage || MESSAGES[code] || MESSAGES[ErrorCode.UNKNOWN_FORMAT]);
    this.name = 'AppError';
    this.code = code;
    /** 原始例外／技術細節，只給 console，不顯示於 UI。 */
    this.detail = detail;
  }
}

export function messageFor(code) {
  return MESSAGES[code] || MESSAGES[ErrorCode.UNKNOWN_FORMAT];
}

/**
 * 把任何丟出來的東西正規化成 AppError。
 * 原始例外一律記到 console，絕不外流到 UI。
 */
export function toAppError(err, fallbackCode = ErrorCode.DECODE_FAILED) {
  if (err instanceof AppError) {
    if (err.detail) console.error('[converter]', err.code, err.detail);
    return err;
  }
  // 從瀏覽器原生例外辨識常見情況
  const raw = err && (err.message || String(err));
  console.error('[converter] 原始例外：', err);
  if (err && (err.name === 'RangeError' || /allocation|out of memory|Array buffer allocation/i.test(raw || ''))) {
    return new AppError(ErrorCode.OUT_OF_MEMORY, err);
  }
  return new AppError(fallbackCode, err);
}

/** 從 worker 傳回主執行緒的可序列化錯誤 → AppError */
export function fromWire(wire) {
  const e = new AppError(wire && wire.code ? wire.code : ErrorCode.DECODE_FAILED, wire && wire.detail);
  if (wire && wire.message) e.message = wire.message;
  return e;
}

/** AppError → 可透過 postMessage 傳遞的純物件 */
export function toWire(err) {
  const e = err instanceof AppError ? err : toAppError(err);
  return { code: e.code, message: e.message, detail: e.detail ? String(e.detail && e.detail.message || e.detail) : null };
}
