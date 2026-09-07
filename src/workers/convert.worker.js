/**
 * convert.worker.js — 轉換工作執行緒。
 *
 * 設計重點：解碼後的 RGBA 中間層盡量留在 worker 內完成編碼再送出，
 * 避免 48 MB 級的 ImageData 在主執行緒與 worker 之間來回搬運。
 * PDF 的「輸入」在主執行緒（PDF.js 自帶 worker），主執行緒把每頁 RGBA 以
 * Transferable 丟進來編碼。
 *
 * 訊息協定：
 *   → { id, type, payload }
 *   ← { id, ok:true, result }            完成
 *   ← { id, ok:false, error }            失敗（error.message 已是可讀中文）
 *   ← { id, progress:{stage, value} }    進度：decode / encode
 */

import { decodeImage } from '../codecs/image-decode.js';
import { encodeImage, encodeThumbnail } from '../codecs/image-encode.js';
import { decodeHeic } from '../codecs/heic-decode.js';
import { encodePdf } from '../codecs/pdf-encode.js';
import { encodeHeic, ENABLED as HEIC_ENCODE_ENABLED } from '../codecs/heic-encode.js';
import { toWire, AppError, ErrorCode } from '../core/errors.js';

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (id, stage, value) => post({ id, progress: { stage, value } });

/** 掃描 alpha 通道，判斷是否真的有透明像素（決定嵌入 PDF 時用 PNG 還是 JPEG） */
function hasTransparency(image) {
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) return true;
  }
  return false;
}

/** 依來源格式解碼成統一中間層 */
async function decodeAny(bytes, sourceFormat) {
  if (sourceFormat === 'heic') {
    const r = await decodeHeic(bytes);
    return {
      image: r.image,
      meta: {
        imageCount: r.imageCount,
        orientation: r.orientation,
        appliedOrientation: r.appliedOrientation,
        containerTransform: r.containerTransform || null,
        decodePath: r.path,
      },
    };
  }
  const image = await decodeImage(bytes, sourceFormat === 'png' ? 'image/png' : 'image/jpeg');
  return { image, meta: {} };
}

async function handle(type, payload, id) {
  switch (type) {
    case 'ping':
      return {
        offscreen: typeof OffscreenCanvas === 'function',
        heicEncode: HEIC_ENCODE_ENABLED,
      };

    /** HEIC 探測：只回尺寸與小縮圖，不把整張 RGBA 送回主執行緒 */
    case 'probe-heic': {
      const r = await decodeHeic(payload.bytes);
      const thumb = await encodeThumbnail(r.image, payload.thumbEdge || 96);
      const out = {
        width: r.image.width,
        height: r.image.height,
        imageCount: r.imageCount,
        orientation: r.orientation,
        appliedOrientation: r.appliedOrientation,
        containerTransform: r.containerTransform || null,
        ispe: r.ispe || null,
        rawSize: r.rawSize || null,
        decodePath: r.path,
        thumb,
      };
      r.image.data = null;    // 立刻釋放
      return out;
    }

    /** 影像 → 影像：解碼與編碼都在 worker 內完成 */
    case 'convert-image': {
      progress(id, 'decode', 0);
      const { image, meta } = await decodeAny(payload.bytes, payload.sourceFormat);
      progress(id, 'decode', 1);
      const srcSize = { width: image.width, height: image.height };
      let out;
      if (payload.options.format === 'heic') {
        out = await encodeHeic(image, { maxEdge: payload.options.maxEdge });
      } else {
        out = await encodeImage(image, payload.options);
      }
      image.data = null;
      progress(id, 'encode', 1);
      return { blob: out.blob, width: out.width, height: out.height, srcSize, meta };
    }

    /** 影像 → 可嵌入 PDF 的壓縮位元組（HEIC 或需要縮放時才走這裡） */
    case 'to-embeddable': {
      progress(id, 'decode', 0);
      const { image, meta } = await decodeAny(payload.bytes, payload.sourceFormat);
      progress(id, 'decode', 1);
      // 'auto'：真的有透明像素才用 PNG（保留 alpha），否則用 JPEG（檔案小很多）
      const format = payload.embedFormat === 'auto'
        ? (hasTransparency(image) ? 'png' : 'jpeg')
        : payload.embedFormat;
      const out = await encodeImage(image, { ...payload.options, format });
      image.data = null;
      progress(id, 'encode', 1);
      const bytes = new Uint8Array(await out.blob.arrayBuffer());
      return { kind: format, bytes, width: out.width, height: out.height, meta, transfer: [bytes.buffer] };
    }

    /** 已經是 RGBA（來自 PDF 頁面）→ 編碼 */
    case 'encode-image': {
      progress(id, 'encode', 0);
      const image = payload.image;
      const out = payload.options.format === 'heic'
        ? await encodeHeic(image, { maxEdge: payload.options.maxEdge })
        : await encodeImage(image, payload.options);
      image.data = null;
      progress(id, 'encode', 1);
      return { blob: out.blob, width: out.width, height: out.height };
    }

    /** 已經是 RGBA（來自 PDF 頁面）→ 壓縮位元組（給 PDF→PDF 之外的組合用） */
    case 'encode-embeddable': {
      const image = payload.image;
      const format = payload.embedFormat;
      const out = await encodeImage(image, { ...payload.options, format });
      image.data = null;
      const bytes = new Uint8Array(await out.blob.arrayBuffer());
      return { kind: format, bytes, width: out.width, height: out.height, transfer: [bytes.buffer] };
    }

    case 'encode-pdf': {
      progress(id, 'encode', 0);
      const out = await encodePdf(payload.sources, payload.settings);
      progress(id, 'encode', 1);
      return { blob: new Blob([out.bytes], { type: 'application/pdf' }), warnings: out.warnings };
    }

    case 'thumbnail': {
      const blob = await encodeThumbnail(payload.image, payload.maxEdge || 96);
      payload.image.data = null;
      return { blob };
    }

    default:
      throw new AppError(ErrorCode.PATH_UNSUPPORTED, `unknown worker task ${type}`);
  }
}

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data || {};
  try {
    const result = await handle(type, payload, id);
    const transfer = result && result.transfer ? result.transfer : [];
    if (result && result.transfer) delete result.transfer;
    post({ id, ok: true, result }, transfer);
  } catch (err) {
    post({ id, ok: false, error: toWire(err) });
  }
};

self.onerror = (e) => { console.error('[worker] 未捕捉的錯誤', e); };

