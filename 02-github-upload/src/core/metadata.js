/**
 * metadata.js — 輸出檔的解析度中繼資料改寫。
 *
 * 需求第 9.4 節。依 HTML 規範，canvas 產生的影像其解析度中繼資料會被固定成
 * 96 dpi（或根本不寫），所以編碼後必須手動改寫，否則使用者設定的 dpi 等於無效。
 *
 * 位元組配置已用真實檔案驗證（見 tools/inspect-dpi.py 與 README 的驗證紀錄）：
 *   PNG  pHYs : 00000009 | 'pHYs' | XPPM(4,BE) | YPPM(4,BE) | unit(1) | CRC32(4)
 *               每公尺像素數 = round(dpi / 0.0254)，unit = 1 表示公尺。
 *               區塊插在 IHDR 之後、IDAT 之前。
 *   JPEG APP0 : FFE0 | length(2,BE，含自身) | 'JFIF\0' | ver(2) | units(1)
 *               | Xdensity(2,BE) | Ydensity(2,BE) | thumbW(1) | thumbH(1)
 *               units = 1 表示每英寸。整段長度 16（無縮圖）。
 */

/* ---------- CRC32（PNG 用，多項式 0xEDB88320） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** dpi → 每公尺像素數 */
export function dpiToPixelsPerMetre(dpi) {
  return Math.max(1, Math.round(dpi / 0.0254));
}

/**
 * 在 PNG 位元組流中插入／改寫 pHYs 區塊。
 * @param {Uint8Array} png
 * @param {number} dpi
 * @returns {Uint8Array} 新的位元組流（原輸入不變更）
 */
export function setPngDpi(png, dpi) {
  for (let i = 0; i < 8; i++) {
    if (png[i] !== PNG_SIG[i]) return png; // 不是 PNG，原樣回傳
  }
  const ppm = dpiToPixelsPerMetre(dpi);

  // 組出新的 pHYs 區塊（21 位元組）
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);                       // 資料長度
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);   // 'pHYs'
  dv.setUint32(8, ppm);                     // X 每公尺像素數
  dv.setUint32(12, ppm);                    // Y 每公尺像素數
  chunk[16] = 1;                            // 單位 = 公尺
  dv.setUint32(17, crc32(chunk, 4, 17));    // CRC 涵蓋 型別 + 資料

  // 掃描區塊，移除既有 pHYs，並記下 IHDR 結束位置
  const src = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const keep = [];
  let off = 8;
  let insertAt = -1;
  while (off + 8 <= png.length) {
    const len = src.getUint32(off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    const total = 12 + len;
    if (off + total > png.length) { keep.push([off, png.length]); break; } // 截斷檔案，原樣保留尾巴
    if (type !== 'pHYs') keep.push([off, off + total]);
    if (type === 'IHDR') insertAt = keep.length; // 插在 IHDR 之後
    off += total;
    if (type === 'IEND') break;
  }
  if (insertAt < 0) return png; // 沒有 IHDR，不動它

  let size = 8 + 21;
  for (const [a, b] of keep) size += b - a;
  const out = new Uint8Array(size);
  out.set(png.subarray(0, 8), 0);
  let p = 8;
  keep.forEach((range, idx) => {
    if (idx === insertAt) { out.set(chunk, p); p += 21; }
    const [a, b] = range;
    out.set(png.subarray(a, b), p);
    p += b - a;
  });
  if (insertAt === keep.length) { out.set(chunk, p); p += 21; }
  return out.subarray(0, p);
}

/** 讀回 PNG 的 pHYs（自我驗證用） */
export function getPngDpi(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  while (off + 8 <= png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    if (type === 'pHYs' && len === 9) {
      const x = dv.getUint32(off + 8);
      const y = dv.getUint32(off + 12);
      const unit = png[off + 16];
      if (unit !== 1) return null;
      return { x: x * 0.0254, y: y * 0.0254 };
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return null;
}

/**
 * 改寫 JPEG 的 JFIF APP0 密度欄位；沒有 APP0 就在 SOI 之後插入一個完整的。
 * @param {Uint8Array} jpg
 * @param {number} dpi
 * @returns {Uint8Array}
 */
export function setJpegDpi(jpg, dpi) {
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) return jpg; // 不是 JPEG
  const density = Math.max(1, Math.min(65535, Math.round(dpi)));

  // 找既有的 APP0 JFIF
  let off = 2;
  while (off + 4 <= jpg.length) {
    if (jpg[off] !== 0xff) break;
    const marker = jpg[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // 進入影像資料
    const len = (jpg[off + 2] << 8) | jpg[off + 3];
    if (len < 2 || off + 2 + len > jpg.length) break;
    if (marker === 0xe0 && len >= 16
        && jpg[off + 4] === 0x4a && jpg[off + 5] === 0x46
        && jpg[off + 6] === 0x49 && jpg[off + 7] === 0x46 && jpg[off + 8] === 0x00) {
      const out = jpg.slice();
      const s = off + 4;
      out[s + 7] = 1;                          // units = 每英寸
      out[s + 8] = (density >> 8) & 0xff;      // Xdensity
      out[s + 9] = density & 0xff;
      out[s + 10] = (density >> 8) & 0xff;     // Ydensity
      out[s + 11] = density & 0xff;
      return out;
    }
    off += 2 + len;
  }

  // 沒有 APP0 → 在 SOI 之後插入一段標準 JFIF APP0（18 位元組）
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,  // 'JFIF\0'
    0x01, 0x01,                    // version 1.01
    0x01,                          // units = 每英寸
    (density >> 8) & 0xff, density & 0xff,
    (density >> 8) & 0xff, density & 0xff,
    0x00, 0x00,                    // 無縮圖
  ]);
  const out = new Uint8Array(jpg.length + app0.length);
  out.set(jpg.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(jpg.subarray(2), 2 + app0.length);
  return out;
}

/** 讀回 JPEG 的 JFIF 密度（自我驗證用） */
export function getJpegDpi(jpg) {
  let off = 2;
  while (off + 4 <= jpg.length) {
    if (jpg[off] !== 0xff) return null;
    const marker = jpg[off + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (jpg[off + 2] << 8) | jpg[off + 3];
    if (marker === 0xe0 && len >= 16 && jpg[off + 4] === 0x4a && jpg[off + 5] === 0x46) {
      const s = off + 4;
      const units = jpg[s + 7];
      const x = (jpg[s + 8] << 8) | jpg[s + 9];
      const y = (jpg[s + 10] << 8) | jpg[s + 11];
      if (units === 1) return { x, y };
      if (units === 2) return { x: x * 2.54, y: y * 2.54 };
      return null; // units = 0 只是長寬比，沒有實體解析度
    }
    off += 2 + len;
  }
  return null;
}

/** 依格式分派 */
export function applyDpi(bytes, format, dpi) {
  if (format === 'png') return setPngDpi(bytes, dpi);
  if (format === 'jpeg') return setJpegDpi(bytes, dpi);
  return bytes; // PDF 不適用：實體尺寸由頁面尺寸決定
}
