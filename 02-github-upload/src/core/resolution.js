/**
 * resolution.js — 解析度數值、單位換算、上限鉗制、輸出尺寸預估。
 *
 * 需求第 9 節。解析度在三種情境下語意不同（9.3），這裡分別提供三支函式，
 * 不共用同一套邏輯。
 */

export const Unit = {
  DPI: 'dpi',       // 像素/英寸
  PPCM: 'ppcm',     // 像素/公分
};

export const UNIT_LABEL = {
  [Unit.DPI]: '像素/英寸',
  [Unit.PPCM]: '像素/公分',
};

/** 允許範圍（以 dpi 為準，第 4.2 節暫定 1–1200） */
export const DPI_MIN = 1;
export const DPI_MAX = 1200;

/** PDF 使用者空間單位為 1/72 英吋 */
export const PDF_UNITS_PER_INCH = 72;

const INCH_PER_CM = 2.54;

/** 像素/公分 → 像素/英寸（保留完整精度） */
export const ppcmToDpi = (v) => v * INCH_PER_CM;
/** 像素/英寸 → 像素/公分（保留完整精度） */
export const dpiToPpcm = (v) => v / INCH_PER_CM;

/** 顯示用：四捨五入到小數點後 1 位，去掉多餘的 .0 */
export function displayRound(v) {
  if (!Number.isFinite(v)) return '';
  const r = Math.round(v * 10) / 10;
  return String(r);
}

/** 把使用者輸入的字串 + 單位換算成 dpi。回傳 null 表示不是合法數字。 */
export function parseToDpi(raw, unit) {
  if (typeof raw === 'number') return unit === Unit.PPCM ? ppcmToDpi(raw) : raw;
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return null;
  // 只接受正數（允許小數），不接受 1e3、+5、Infinity 這類寫法造成的混淆
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === Unit.PPCM ? ppcmToDpi(n) : n;
}

/**
 * 驗證使用者輸入。
 * 需求 9.2：超出範圍時不自動改掉使用者打的數字，只回報錯誤。
 * @returns {{ok:true, dpi:number}|{ok:false, message:string}}
 */
export function validate(raw, unit) {
  const dpi = parseToDpi(raw, unit);
  if (dpi === null) {
    return { ok: false, message: `請輸入 ${DPI_MIN} 到 ${DPI_MAX} 之間的數值` };
  }
  if (dpi < DPI_MIN - 1e-9 || dpi > DPI_MAX + 1e-9) {
    if (unit === Unit.PPCM) {
      const lo = displayRound(dpiToPpcm(DPI_MIN));
      const hi = displayRound(dpiToPpcm(DPI_MAX));
      return { ok: false, message: `請輸入 ${lo} 到 ${hi} 之間的數值（像素/公分）` };
    }
    return { ok: false, message: `請輸入 ${DPI_MIN} 到 ${DPI_MAX} 之間的數值` };
  }
  return { ok: true, dpi };
}

/* ------------------------------------------------------------------ */
/* 9.3 三種情境各自的語意                                              */
/* ------------------------------------------------------------------ */

/**
 * 情境 A：PDF → 影像。解析度決定渲染倍率與輸出像素尺寸。
 * @param {{width:number,height:number}} ptSize 頁面尺寸（PDF pt）
 */
export function pdfRenderScale(dpi) {
  return dpi / PDF_UNITS_PER_INCH;
}
export function pdfPageOutputPixels(ptSize, dpi) {
  const s = pdfRenderScale(dpi);
  return { width: Math.max(1, Math.floor(ptSize.width * s)), height: Math.max(1, Math.floor(ptSize.height * s)) };
}

/**
 * 情境 B：影像 → 影像。解析度「只改寫中繼資料，不改變像素尺寸」。
 * 像素尺寸只受「最長邊上限」影響。
 */
export function imageOutputPixels(srcSize, maxEdge) {
  if (!maxEdge || maxEdge <= 0) return { width: srcSize.width, height: srcSize.height, scaled: false };
  const longest = Math.max(srcSize.width, srcSize.height);
  if (longest <= maxEdge) return { width: srcSize.width, height: srcSize.height, scaled: false };
  const k = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(srcSize.width * k)),
    height: Math.max(1, Math.round(srcSize.height * k)),
    scaled: true,
  };
}

/**
 * 情境 C：影像 → PDF。解析度決定像素換算成 PDF 實體尺寸的比例。
 * 實體寬度(pt) = 像素寬度 / dpi * 72
 */
export function pixelsToPdfPoints(px, dpi) {
  return (px / dpi) * PDF_UNITS_PER_INCH;
}
export function imagePhysicalSizePt(srcSize, dpi) {
  return {
    width: pixelsToPdfPoints(srcSize.width, dpi),
    height: pixelsToPdfPoints(srcSize.height, dpi),
  };
}

/* ------------------------------------------------------------------ */

/** 標準頁面尺寸（pt），第 4.2 節查表值 */
export const PAGE_SIZES = {
  a4: { label: 'A4', width: 595.28, height: 841.89 },
  a3: { label: 'A3', width: 841.89, height: 1190.55 },
  letter: { label: 'Letter', width: 612, height: 792 },
};

/**
 * 依 canvas 上限鉗制，回傳建議的替代 dpi（不會自動套用，只提供給確認對話框）。
 * 需求 9.5：不得在使用者不知情下自動降解析度。
 */
export function suggestDpiWithinLimits(ptSize, dpi, limits) {
  const want = pdfPageOutputPixels(ptSize, dpi);
  if (fitsLimits(want, limits)) return null;
  // 依最嚴格的那個限制往下算
  const byW = limits.maxDimension / ptSize.width * PDF_UNITS_PER_INCH;
  const byH = limits.maxDimension / ptSize.height * PDF_UNITS_PER_INCH;
  const byArea = Math.sqrt(limits.maxArea / (ptSize.width * ptSize.height)) * PDF_UNITS_PER_INCH;
  const best = Math.floor(Math.min(byW, byH, byArea, DPI_MAX));
  const suggested = Math.max(DPI_MIN, best);
  return { suggested, wouldBe: want, alt: pdfPageOutputPixels(ptSize, suggested) };
}

export function fitsLimits(size, limits) {
  if (!limits) return true;
  return size.width <= limits.maxDimension
    && size.height <= limits.maxDimension
    && size.width * size.height <= limits.maxArea;
}

/** 「輸出約 4134 × 5846 像素」 */
export function formatPixels(size) {
  return `${size.width.toLocaleString('zh-TW')} × ${size.height.toLocaleString('zh-TW')} 像素`;
}
