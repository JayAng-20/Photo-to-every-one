/**
 * detect.js — 以檔案內容（magic bytes / ftyp brand）判定格式。
 *
 * 需求第 7 節：一律以內容為準，副檔名只在偵測失敗時輔助提示。
 * 副檔名與內容不符時以內容為準繼續處理，並回報 mismatch 讓 UI 標註。
 */

import { AppError, ErrorCode } from './errors.js';

/** 內部統一的格式代號 */
export const Fmt = {
  PDF: 'pdf',
  PNG: 'png',
  JPEG: 'jpeg',
  HEIC: 'heic',   // HEIF 容器 + HEVC，UI 顯示為「HEIF/HEIC」
  AVIF: 'avif',   // 偵測得出來但不支援轉換
  WEBP: 'webp',
  GIF: 'gif',
  TIFF: 'tiff',
  BMP: 'bmp',
  UNKNOWN: 'unknown',
};

/** UI 顯示名稱 */
export const FMT_LABEL = {
  [Fmt.PDF]: 'PDF',
  [Fmt.PNG]: 'PNG',
  [Fmt.JPEG]: 'JPEG',
  [Fmt.HEIC]: 'HEIF/HEIC',
  [Fmt.AVIF]: 'AVIF',
  [Fmt.WEBP]: 'WebP',
  [Fmt.GIF]: 'GIF',
  [Fmt.TIFF]: 'TIFF',
  [Fmt.BMP]: 'BMP',
  [Fmt.UNKNOWN]: '未知格式',
};

/** 本工具可以「讀入」的格式 */
export const READABLE = new Set([Fmt.PDF, Fmt.PNG, Fmt.JPEG, Fmt.HEIC]);

/** 本工具可以「輸出」的格式（HEIC 由 Phase 2 能力偵測另行決定是否可用） */
export const WRITABLE = new Set([Fmt.PDF, Fmt.PNG, Fmt.JPEG, Fmt.HEIC]);

const HEIF_IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

const td = new TextDecoder('latin1');

function ascii(bytes, start, len) {
  return td.decode(bytes.subarray(start, start + len));
}

function startsWith(bytes, sig) {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/**
 * 解析 ISO BMFF 的第一個 ftyp box。
 * @returns {{major:string, minor:number, compatible:string[]}|null}
 */
export function parseFtyp(bytes) {
  if (bytes.length < 12) return null;
  if (ascii(bytes, 4, 4) !== 'ftyp') return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = dv.getUint32(0);
  let headerLen = 8;
  if (size === 1) {
    if (bytes.length < 16) return null;
    // 64-bit largesize；ftyp 不可能真的這麼大，只取低 32 位避免 BigInt
    size = dv.getUint32(12);
    headerLen = 16;
  } else if (size === 0) {
    size = bytes.length;
  }
  if (size < headerLen + 8) size = Math.min(bytes.length, headerLen + 8);
  const major = ascii(bytes, headerLen, 4).trim();
  const minor = dv.getUint32(headerLen + 4);
  const compatible = [];
  const end = Math.min(size, bytes.length);
  for (let off = headerLen + 8; off + 4 <= end; off += 4) {
    const b = ascii(bytes, off, 4).trim();
    if (b) compatible.push(b);
  }
  return { major, minor, compatible };
}

/**
 * 從一段位元組（建議前 4 KB 就夠）判定格式。
 * @param {Uint8Array} bytes
 * @returns {{format:string, brand?:string, brands?:string[], reason?:string}}
 */
export function detectBytes(bytes) {
  if (!bytes || bytes.length < 4) return { format: Fmt.UNKNOWN };

  // PNG：8 位元組簽章
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { format: Fmt.PNG };

  // JPEG：FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { format: Fmt.JPEG };

  // PDF：開頭 %PDF-。實務上有些檔案前面有少量垃圾位元組，容忍前 1 KB 內出現。
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { format: Fmt.PDF };
  {
    const head = ascii(bytes, 0, Math.min(1024, bytes.length));
    const at = head.indexOf('%PDF-');
    if (at > 0) return { format: Fmt.PDF, reason: 'offset' };
  }

  // GIF
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { format: Fmt.GIF };

  // BMP
  if (startsWith(bytes, [0x42, 0x4d])) return { format: Fmt.BMP };

  // TIFF（II*\0 / MM\0*）
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { format: Fmt.TIFF };
  }

  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && ascii(bytes, 8, 4) === 'WEBP') {
    return { format: Fmt.WEBP };
  }

  // ISO BMFF 家族（HEIF / AVIF）
  const ftyp = parseFtyp(bytes);
  if (ftyp) {
    const all = [ftyp.major, ...ftyp.compatible];
    const lower = all.map((b) => b.toLowerCase());
    if (lower.some((b) => AVIF_BRANDS.has(b))) {
      return { format: Fmt.AVIF, brand: ftyp.major, brands: all };
    }
    if (lower.some((b) => HEIF_IMAGE_BRANDS.has(b))) {
      return { format: Fmt.HEIC, brand: ftyp.major, brands: all };
    }
    // 未知 brand：仍交給 libheif 試（第 7 節），失敗再回報無法辨識
    return { format: Fmt.HEIC, brand: ftyp.major, brands: all, reason: 'unknown-brand' };
  }

  return { format: Fmt.UNKNOWN };
}

const EXT_MAP = {
  pdf: Fmt.PDF,
  png: Fmt.PNG,
  jpg: Fmt.JPEG, jpeg: Fmt.JPEG, jpe: Fmt.JPEG, jfif: Fmt.JPEG,
  heic: Fmt.HEIC, heif: Fmt.HEIC, hif: Fmt.HEIC,
  avif: Fmt.AVIF, webp: Fmt.WEBP, gif: Fmt.GIF,
  tif: Fmt.TIFF, tiff: Fmt.TIFF, bmp: Fmt.BMP,
};

/** 每種格式最常見的副檔名，用來判斷是否需要在狀態列標註實際格式 */
export const PRIMARY_EXT = { [Fmt.PDF]: 'pdf', [Fmt.PNG]: 'png', [Fmt.JPEG]: 'jpg', [Fmt.HEIC]: 'heic' };

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : null;
}

export function formatFromExtension(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  if (!m) return null;
  return EXT_MAP[m[1].toLowerCase()] || null;
}

/**
 * 讀 File 的前 4 KB 做判定。
 * @param {File|Blob} file
 * @param {string} name 原始檔名（只用於 mismatch 提示）
 */
export async function detectFile(file, name) {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const res = detectBytes(head);
  const label = name || (file && file.name) || '';
  const byExt = formatFromExtension(label);
  const ext = extensionOf(label);
  res.ext = ext;
  res.extFormat = byExt;
  // 內容判定成功但與副檔名不符 → 標註（第 7 節）
  res.mismatch = res.format !== Fmt.UNKNOWN && byExt !== null && byExt !== res.format;
  // 副檔名雖然對得上，但不是該格式最常見的寫法（例如 .heic 被改名成 .heif、
  // 或根本沒有副檔名）→ 也把實際格式標出來，讓使用者知道判定結果
  res.extAlias = !res.mismatch
    && res.format !== Fmt.UNKNOWN
    && READABLE.has(res.format)
    && ext !== PRIMARY_EXT[res.format];
  return res;
}

/**
 * 粗略檢查位元組流是不是「結構完整」的 PNG / JPEG。
 *
 * 用途：影像 → PDF 時我們會直接嵌入原始位元組（避免重新編碼掉品質），
 * 但 pdf-lib 的 PNG 解析器遇到截斷的檔案會卡住而不是丟例外，
 * 所以嵌入前先確認檔尾存在，不完整就改走解碼路徑（會乾淨地回報損毀）。
 */
export function looksComplete(bytes, format) {
  if (!bytes || bytes.length < 16) return false;
  if (format === Fmt.PNG) {
    // 結尾必須是 IEND 區塊：00 00 00 00 'IEND' + CRC(4)
    const n = bytes.length;
    return bytes[n - 8] === 0x49 && bytes[n - 7] === 0x45
        && bytes[n - 6] === 0x4e && bytes[n - 5] === 0x44;
  }
  if (format === Fmt.JPEG) {
    // 結尾必須是 EOI（FF D9），容忍最後幾個填充位元組
    for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 8); i--) {
      if (bytes[i] === 0xd9 && bytes[i - 1] === 0xff) return true;
    }
    return false;
  }
  return true;
}

/** 把偵測結果轉成「不能處理」的錯誤；可以處理則回傳 null。 */
export function rejectionFor(det) {
  if (det.format === Fmt.AVIF) return new AppError(ErrorCode.AVIF_UNSUPPORTED);
  if (det.format === Fmt.UNKNOWN) return new AppError(ErrorCode.UNKNOWN_FORMAT);
  if (!READABLE.has(det.format)) {
    return new AppError(
      ErrorCode.UNKNOWN_FORMAT,
      null,
      `目前不支援 ${FMT_LABEL[det.format]} 檔案，只支援 PDF、PNG、JPEG、HEIF/HEIC`
    );
  }
  return null;
}
