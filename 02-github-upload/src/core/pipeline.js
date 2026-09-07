/**
 * pipeline.js — 統一轉換流程調度。
 *
 * 需求 6.3：PDF 是唯一的多頁特例，「單張 vs 多張」的展開與收攏一律在這裡處理，
 * 不讓各 codec 自己處理。
 * 需求 10：同時在記憶體中的 ImageData 數量上限 = Worker 數量。
 */

import { Fmt, FMT_LABEL, looksComplete } from './detect.js';
import { AppError, ErrorCode } from './errors.js';
import { openPdf, parsePageRange } from '../codecs/pdf-decode.js';

/* ------------------------------------------------------------------ */
/* 支援矩陣                                                            */
/* ------------------------------------------------------------------ */

/** 九條核心路徑 + 同格式重新輸出。key = `${in}->${out}` */
const MATRIX = new Set([
  'pdf->png', 'pdf->jpeg',                       // 核心 1、2
  'png->pdf', 'jpeg->pdf',                       // 核心 3、4
  'png->jpeg', 'jpeg->png',                      // 核心 5、6
  'heic->png', 'heic->jpeg', 'heic->pdf',        // 核心 7、8、9
  'png->png', 'jpeg->jpeg',                      // 同格式：改寫解析度中繼資料／縮放
]);

/** Phase 2 才會開放的輸出 HEIC 路徑 */
const HEIC_OUT = new Set(['png->heic', 'jpeg->heic', 'pdf->heic', 'heic->heic']);

export function isSupported(inFmt, outFmt, heicEncodeEnabled = false) {
  const key = `${inFmt}->${outFmt}`;
  if (MATRIX.has(key)) return true;
  if (HEIC_OUT.has(key)) return !!heicEncodeEnabled;
  return false;
}

export function unsupportedReason(inFmt, outFmt, heicEncodeEnabled = false) {
  if (inFmt === Fmt.PDF && outFmt === Fmt.PDF) return '這個檔案已經是 PDF，不需要轉換';
  if (HEIC_OUT.has(`${inFmt}->${outFmt}`) && !heicEncodeEnabled) {
    return '目前瀏覽器環境無法輸出 HEIF/HEIC，建議改用 JPEG 或 PNG';
  }
  return `目前不支援從 ${FMT_LABEL[inFmt] || inFmt} 轉成 ${FMT_LABEL[outFmt] || outFmt}`;
}

/** 需求 9.6.5：依輸入格式給合理的輸出預設值 */
export function defaultOutputFor(inFmt) {
  switch (inFmt) {
    case Fmt.HEIC: return Fmt.JPEG;
    case Fmt.PDF: return Fmt.PNG;
    case Fmt.PNG: return Fmt.PDF;
    case Fmt.JPEG: return Fmt.PDF;
    default: return Fmt.PNG;
  }
}

export const EXT = { png: 'png', jpeg: 'jpg', pdf: 'pdf', heic: 'heic' };

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export function baseName(name) {
  const noPath = String(name || 'output').replace(/[\\/]+/g, '_');
  const dot = noPath.lastIndexOf('.');
  return dot > 0 ? noPath.slice(0, dot) : noPath;
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

/** 讓 PDF 輸入一次只處理一個檔，避免多個大 canvas 同時存在 */
class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const next = this.p.then(fn, fn);
    this.p = next.then(() => {}, () => {});
    return next;
  }
}

/* ------------------------------------------------------------------ */
/* 轉換執行                                                            */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} RunContext
 * @property {Array} items          要處理的檔案項目
 * @property {Object} settings      輸出設定
 * @property {Object} pool          WorkerPool
 * @property {Object} limits        canvas 上限
 * @property {boolean} heicEncodeEnabled
 * @property {Object} hooks         onStart/onProgress/onOutput/onDone/onError/onUnsupported/onWarning/onBatchOutput
 * @property {()=>boolean} isCancelled
 */

function encodeOptions(settings) {
  return {
    format: settings.format,
    quality: settings.quality,
    dpi: settings.dpi,
    background: settings.background,
    maxEdge: settings.maxEdgeEnabled ? settings.maxEdge : null,
    limits: settings.limits || null,
  };
}

function throwIfCancelled(ctx) {
  if (ctx.isCancelled()) throw new AppError(ErrorCode.CANCELLED);
}

/** 影像檔 → 可直接嵌入 PDF 的壓縮位元組 */
async function makeEmbeddable(item, ctx) {
  const { settings, pool } = ctx;
  const known = item.meta || {};
  const needResize = !!(settings.maxEdgeEnabled && settings.maxEdge
    && known.width && Math.max(known.width, known.height) > settings.maxEdge);

  // JPEG / PNG 且不需要重新縮放 → 直接嵌入原始位元組，不重新編碼、不掉品質。
  // 前提是檔案在加入時已經成功讀出尺寸，而且結構完整（截斷的 PNG 會讓 pdf-lib 卡住）。
  if (!needResize && known.width && (item.format === Fmt.JPEG || item.format === Fmt.PNG)) {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    if (!looksComplete(bytes, item.format)) {
      throw new AppError(ErrorCode.CORRUPT_FILE, `${item.name}: truncated ${item.format}`);
    }
    return {
      kind: item.format === Fmt.JPEG ? 'jpeg' : 'png',
      bytes,
      width: known.width || 0,
      height: known.height || 0,
      name: item.name,
      transfer: [bytes.buffer],
      reencoded: false,
    };
  }

  // 其餘（HEIC 來源、或需要縮放）走 RGBA 中間層再編碼
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  const res = await pool.run(
    'to-embeddable',
    {
      bytes,
      sourceFormat: item.format,
      embedFormat: 'auto',
      options: encodeOptions(settings),
    },
    [bytes.buffer],
    (p) => ctx.hooks.onProgress(item, p.stage === 'decode' ? 0.2 + p.value * 0.4 : 0.6 + p.value * 0.3)
  );
  return {
    kind: res.kind,
    bytes: res.bytes,
    width: res.width,
    height: res.height,
    name: item.name,
    transfer: [res.bytes.buffer],
    reencoded: true,
    meta: res.meta,
  };
}

function pdfSettingsOf(settings) {
  return {
    pageSize: settings.pdf.pageSize,
    orientation: settings.pdf.orientation,
    fitToPage: settings.pdf.fitToPage,
    keepAspect: settings.pdf.keepAspect,
    dpi: settings.dpi,
  };
}

/** PDF → PNG/JPEG（多頁展開） */
async function pdfToImages(item, ctx) {
  const { settings, pool, limits, hooks } = ctx;
  const ext = EXT[settings.format];
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  const pdf = await openPdf(bytes);
  try {
    const pages = parsePageRange(settings.pageRange, pdf.numPages);
    // 序號補零到與總頁數等寬，最少 3 位（原檔名_p001.png），確保檔案總管排序正確
    const pad = Math.max(3, String(pdf.numPages).length);
    const base = baseName(item.name);
    hooks.onProgress(item, 0.1);
    for (let k = 0; k < pages.length; k++) {
      throwIfCancelled(ctx);
      const n = pages[k];
      const rgba = await pdf.renderPage(n, settings.dpi, limits);
      hooks.onProgress(item, 0.1 + ((k + 0.5) / pages.length) * 0.85);
      const res = await pool.run(
        'encode-image',
        { image: rgba, options: encodeOptions(settings) },
        [rgba.data.buffer]
      );
      rgba.data = null;           // 立刻釋放這一頁
      const name = `${base}_p${String(n).padStart(pad, '0')}.${ext}`;
      hooks.onOutput(item, name, res.blob);
      hooks.onProgress(item, 0.1 + ((k + 1) / pages.length) * 0.85);
      await yieldToUi();          // 讓介面保持可捲動、可取消
    }
  } finally {
    await pdf.destroy();
  }
}

/** 影像 → 影像 */
async function imageToImage(item, ctx) {
  const { settings, pool, hooks } = ctx;
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  hooks.onProgress(item, 0.1);
  const res = await pool.run(
    'convert-image',
    { bytes, sourceFormat: item.format, options: encodeOptions(settings) },
    [bytes.buffer],
    (p) => hooks.onProgress(item, p.stage === 'decode' ? 0.1 + p.value * 0.5 : 0.6 + p.value * 0.35)
  );
  const name = `${baseName(item.name)}.${EXT[settings.format]}`;
  hooks.onOutput(item, name, res.blob, res);
  return res;
}

/** 影像 → 各自獨立 PDF */
async function imageToOwnPdf(item, ctx) {
  const { settings, pool, hooks } = ctx;
  const src = await makeEmbeddable(item, ctx);
  throwIfCancelled(ctx);
  const res = await pool.run('encode-pdf', { sources: [src], settings: pdfSettingsOf(settings) }, src.transfer);
  if (res.warnings && res.warnings.length) res.warnings.forEach((w) => hooks.onWarning(item, w));
  hooks.onOutput(item, `${baseName(item.name)}.pdf`, res.blob);
}

/** PDF → HEIC（Phase 2 才會走到；逐頁輸出） */
async function pdfToHeic(item, ctx) {
  return pdfToImages(item, ctx);
}

async function processOne(item, ctx) {
  const { settings, hooks } = ctx;
  hooks.onStart(item);
  throwIfCancelled(ctx);
  const target = settings.format;

  if (item.format === Fmt.PDF) {
    if (target === Fmt.HEIC) return ctx.pdfMutex.run(() => pdfToHeic(item, ctx));
    return ctx.pdfMutex.run(() => pdfToImages(item, ctx));
  }
  if (target === Fmt.PDF) return imageToOwnPdf(item, ctx);
  return imageToImage(item, ctx);
}

/** 多個影像 → 單一多頁 PDF */
async function mergedPdf(items, ctx) {
  const { settings, pool, hooks } = ctx;
  const sources = [];
  const transfer = [];
  for (const item of items) {
    throwIfCancelled(ctx);
    hooks.onStart(item);
    const src = await makeEmbeddable(item, ctx);
    sources.push(src);
    transfer.push(...src.transfer);
    hooks.onProgress(item, 0.95);
  }
  throwIfCancelled(ctx);
  const res = await pool.run('encode-pdf', { sources, settings: pdfSettingsOf(settings) }, transfer);
  const first = baseName(items[0].name);
  const name = items.length > 1 ? `${first}_等${items.length}個檔案_合併.pdf` : `${first}.pdf`;
  hooks.onBatchOutput(name, res.blob);
  for (const item of items) {
    if (res.warnings) res.warnings.filter((w) => w.includes(item.name)).forEach((w) => hooks.onWarning(item, w));
    hooks.onDone(item, { mergedInto: name });
  }
}

/**
 * 執行整批轉換。單一檔案失敗不會中斷整批。
 * @param {RunContext} ctx
 */
export async function runConversion(ctx) {
  const { items, settings, hooks } = ctx;
  ctx.pdfMutex = new Mutex();

  // 先把不支援的組合標出來，其餘照常處理（需求 9.6.6）
  const usable = [];
  for (const item of items) {
    if (!isSupported(item.format, settings.format, ctx.heicEncodeEnabled)) {
      hooks.onUnsupported(item, unsupportedReason(item.format, settings.format, ctx.heicEncodeEnabled));
    } else {
      usable.push(item);
    }
  }
  if (usable.length === 0) return;

  const mergeMode = settings.format === Fmt.PDF && settings.pdf.merge;
  if (mergeMode) {
    try {
      await mergedPdf(usable, ctx);
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError(ErrorCode.ENCODE_FAILED, e);
      usable.forEach((item) => hooks.onError(item, err));
    }
    return;
  }

  // 並行度 = Worker 數量，保證同時存活的 ImageData 不超過這個數
  const limit = Math.max(1, Math.min(ctx.pool.concurrency, usable.length));
  let cursor = 0;
  const lanes = Array.from({ length: limit }, async () => {
    for (;;) {
      if (ctx.isCancelled()) return;
      const i = cursor++;
      if (i >= usable.length) return;
      const item = usable[i];
      try {
        await processOne(item, ctx);
        hooks.onDone(item);
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError(ErrorCode.DECODE_FAILED, e);
        if (err.code === ErrorCode.CANCELLED) { hooks.onCancelled(item); return; }
        hooks.onError(item, err);
      }
      await yieldToUi();
    }
  });
  await Promise.all(lanes);
}
