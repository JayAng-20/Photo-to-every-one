/**
 * exif.js — 從 HEIF / JPEG 位元組流取出 EXIF Orientation，並提供 RGBA 的方向修正。
 *
 * 需求 8.3：HEIC 常帶 EXIF 方向資訊，必須套用旋轉，否則 iPhone 直式照片會躺著。
 * 這裡直接對 RGBA 緩衝區做搬移，不經過 canvas，避免撞到 canvas 尺寸上限。
 */

/** EXIF Orientation 值 1–8 的意義（1 = 不需處理） */
export const ORIENT = {
  NORMAL: 1, FLIP_H: 2, ROT_180: 3, FLIP_V: 4,
  TRANSPOSE: 5, ROT_90_CW: 6, TRANSVERSE: 7, ROT_270_CW: 8,
};

/** 這些方向會讓寬高互換 */
export function swapsAxes(o) {
  return o === 5 || o === 6 || o === 7 || o === 8;
}

/**
 * 解析 TIFF/EXIF 區塊，取 IFD0 的 Orientation（tag 0x0112）。
 * @param {Uint8Array} buf 整個檔案
 * @param {number} tiffStart TIFF header（'II*\0' 或 'MM\0*'）的位置
 */
function readOrientationFromTiff(buf, tiffStart) {
  if (tiffStart + 8 > buf.length) return null;
  const b0 = buf[tiffStart], b1 = buf[tiffStart + 1];
  let little;
  if (b0 === 0x49 && b1 === 0x49) little = true;
  else if (b0 === 0x4d && b1 === 0x4d) little = false;
  else return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(tiffStart + 2, little) !== 42) return null;
  const ifd0 = tiffStart + dv.getUint32(tiffStart + 4, little);
  if (ifd0 + 2 > buf.length) return null;
  const count = dv.getUint16(ifd0, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > buf.length) break;
    if (dv.getUint16(entry, little) === 0x0112) {
      const type = dv.getUint16(entry + 2, little);
      const v = type === 3 ? dv.getUint16(entry + 8, little) : dv.getUint32(entry + 8, little);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** 在位元組流中找 'Exif\0\0' + TIFF header 的位置（HEIF 的 Exif item 就長這樣） */
function findExifTiff(buf, searchLimit) {
  const limit = Math.min(buf.length - 10, searchLimit || buf.length);
  for (let i = 0; i < limit; i++) {
    if (buf[i] !== 0x45) continue;                       // 'E'
    if (buf[i + 1] !== 0x78 || buf[i + 2] !== 0x69 || buf[i + 3] !== 0x66) continue; // 'xif'
    if (buf[i + 4] !== 0x00 || buf[i + 5] !== 0x00) continue;
    const t = i + 6;
    if ((buf[t] === 0x49 && buf[t + 1] === 0x49 && buf[t + 2] === 0x2a && buf[t + 3] === 0x00)
      || (buf[t] === 0x4d && buf[t + 1] === 0x4d && buf[t + 2] === 0x00 && buf[t + 3] === 0x2a)) {
      return t;
    }
  }
  return -1;
}

/**
 * 從 HEIF 檔案位元組取 Orientation。
 * @returns {number|null} 1–8，或 null（沒有 EXIF）
 */
export function heifOrientation(bytes) {
  const t = findExifTiff(bytes, Math.min(bytes.length, 512 * 1024));
  if (t < 0) return null;
  return readOrientationFromTiff(bytes, t);
}

/** 從 JPEG 的 APP1 取 Orientation（診斷用；瀏覽器解 JPEG 時已自行套用方向） */
export function jpegOrientation(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) return null;
    const marker = bytes[off + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (bytes[off + 2] << 8) | bytes[off + 3];
    if (marker === 0xe1 && len >= 8
      && bytes[off + 4] === 0x45 && bytes[off + 5] === 0x78
      && bytes[off + 6] === 0x69 && bytes[off + 7] === 0x66) {
      return readOrientationFromTiff(bytes, off + 10);
    }
    off += 2 + len;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HEIF 容器內的轉換屬性                                                */
/* ------------------------------------------------------------------ */

const ASCII = new TextDecoder('latin1');
const boxType = (b, off) => ASCII.decode(b.subarray(off + 4, off + 8));

/** 逐一走訪某段範圍內的 ISO BMFF box */
function eachBox(bytes, start, end, fn) {
  let off = start;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    let head = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(dv.getBigUint64(off + 8));
      head = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < head || off + size > end) return;
    fn(boxType(bytes, off), off + head, off + size);
    off += size;
  }
}

/**
 * 讀出 HEIF 容器的 irot / imir / ispe。
 *
 * libheif 解碼時預設就會套用 irot / imir 這類「轉換屬性」，所以只要容器裡有它們，
 * 就不能再套一次 EXIF Orientation（會轉兩次）。這是實測 macOS ImageIO 產生的
 * HEIC（同時帶 EXIF Orientation 6 與 irot angle 3）後確認的行為。
 *
 * @returns {{irot:number|null, imir:number|null, ispe:{width:number,height:number}|null}}
 */
export function heifTransforms(bytes) {
  const res = { irot: null, imir: null, ispe: null };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let metaRange = null;
  eachBox(bytes, 0, bytes.length, (type, s, e) => {
    if (type === 'meta') metaRange = [s + 4, e];   // meta 是 FullBox，跳過 version/flags
  });
  if (!metaRange) return res;

  let ipcoRange = null;
  eachBox(bytes, metaRange[0], metaRange[1], (type, s, e) => {
    if (type !== 'iprp') return;
    eachBox(bytes, s, e, (t2, s2, e2) => { if (t2 === 'ipco') ipcoRange = [s2, e2]; });
  });
  if (!ipcoRange) return res;

  eachBox(bytes, ipcoRange[0], ipcoRange[1], (type, s, e) => {
    if (type === 'irot' && e - s >= 1) res.irot = bytes[s] & 0x03;
    else if (type === 'imir' && e - s >= 1) res.imir = bytes[s] & 0x01;
    else if (type === 'ispe' && e - s >= 12) {
      const w = dv.getUint32(s + 4);
      const h = dv.getUint32(s + 8);
      // ipco 可能同時有縮圖與主影像的 ispe，取面積最大的那個
      if (!res.ispe || w * h > res.ispe.width * res.ispe.height) res.ispe = { width: w, height: h };
    }
  });
  return res;
}

/**
 * 依 EXIF Orientation 重排 RGBA 緩衝區。
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img
 * @param {number} orientation 1–8
 * @returns {{width:number,height:number,data:Uint8ClampedArray}} 方向已修正的新影像
 */
export function applyOrientation(img, orientation) {
  const o = orientation | 0;
  if (!o || o === 1) return img;

  const { width: w, height: h, data: src } = img;
  const swap = swapsAxes(o);
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const dst = new Uint8ClampedArray(ow * oh * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx, dy;
      switch (o) {
        case 2: dx = w - 1 - x; dy = y; break;               // 水平翻轉
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;       // 旋轉 180
        case 4: dx = x;         dy = h - 1 - y; break;       // 垂直翻轉
        case 5: dx = y;         dy = x; break;               // 轉置
        case 6: dx = h - 1 - y; dy = x; break;               // 順時針 90
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;       // 反轉置
        case 8: dx = y;         dy = w - 1 - x; break;       // 順時針 270
        default: dx = x; dy = y;
      }
      const s = (y * w + x) * 4;
      const d = (dy * ow + dx) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }
  return { width: ow, height: oh, data: dst };
}
