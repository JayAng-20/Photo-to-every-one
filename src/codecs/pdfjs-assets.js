/**
 * pdfjs-assets.js — 從打包檔供應 PDF.js 的 cmaps 與 standard_fonts。
 *
 * ## 為什麼可以這樣做
 *
 * PDF.js 6.3.289 把三種二進位資產（cmap、標準字型、wasm）統一成一個工廠，
 * 由 `getDocument({ BinaryDataFactory })` 這個公開參數提供：
 *
 *   O = e.BinaryDataFactory || (isNode ? NodeBinaryDataFactory : DOMBinaryDataFactory)
 *   binaryDataFactory = useWorkerFetch ? null : new O({ cMapUrl, standardFontDataUrl, wasmUrl })
 *   messageHandler.on("FetchBinaryData", t => this.binaryDataFactory.fetch(t))
 *
 * pdf.worker 需要資產時會送 `FetchBinaryData` 訊息，主執行緒轉呼叫
 * `factory.fetch({ kind, filename })`，kind 是 "cMapUrl" / "standardFontDataUrl" /
 * "wasmUrl"。只要傳自訂類別，`O !== DOMBinaryDataFactory`，PDF.js 就會自動把
 * `useWorkerFetch` 設成 false，保證所有請求都經過這裡。
 *
 * 舊版的 `CMapReaderFactory` / `StandardFontDataFactory` 在 6.x 已經不存在，
 * 不要照抄舊範例。這裡沒有修改 vendor/ 底下任何一行第三方程式碼。
 *
 * ## 兩個必須原樣轉發的例外
 *
 * - `kind: "wasmUrl"`（jbig2 / openjpeg / qcms）也走同一個工廠，這裡原樣 fetch 真實檔案。
 * - `iccUrl` **不** 走這個工廠：pdf.worker 內部用 fetchSync() 自己抓，
 *   所以 public/pdfjs/iccs/ 必須維持真實檔案。
 */

import { ASSETS } from '../core/paths.js';

const MAGIC = [0x50, 0x4a, 0x53, 0x50, 0x4b, 0x31, 0x00, 0x00]; // 'PJSPK1\0\0'
const HEADER_FIXED = MAGIC.length + 4;

/** 已載入的打包檔：url -> Promise<{entries, bytes, base, count}>。同一個分頁只抓一次。 */
const packs = new Map();

/** 診斷用：記錄實際被請求過的資產名稱（驗收時要證明 cmap 路徑真的有被走到）。 */
const requestLog = [];

/** @returns {{kind:string, filename:string, bytes:number, from:string}[]} */
export function getAssetRequestLog() {
  return requestLog.slice();
}

export function clearAssetRequestLog() {
  requestLog.length = 0;
}

/** 打包檔只在第一次真的需要時才 fetch，抓到後留在記憶體重複使用。 */
function loadPack(url) {
  let p = packs.get(url);
  if (p) return p;

  p = (async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`PDF.js 資產打包檔載入失敗：${url}（HTTP ${res.status}）`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < HEADER_FIXED) {
      throw new Error(`PDF.js 資產打包檔太短，可能已損毀：${url}`);
    }
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i]) {
        throw new Error(`PDF.js 資產打包檔的識別碼不符，可能不是打包檔：${url}`);
      }
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const indexLength = dv.getUint32(MAGIC.length);
    const base = HEADER_FIXED + indexLength;
    if (base > bytes.length) {
      throw new Error(`PDF.js 資產打包檔的索引長度不合理：${url}`);
    }
    let index;
    try {
      index = JSON.parse(new TextDecoder('utf-8').decode(bytes.subarray(HEADER_FIXED, base)));
    } catch (e) {
      throw new Error(`PDF.js 資產打包檔的索引無法解析：${url}`);
    }
    return { entries: index.entries || {}, count: index.count || 0, source: index.source, bytes, base };
  })().catch((e) => {
    packs.delete(url);          // 失敗不要快取，下次還能重試
    throw e;
  });

  packs.set(url, p);
  return p;
}

/**
 * 從打包檔取出一個資產。
 * @returns {Promise<Uint8Array>} 獨立的副本（不是 subarray 視圖）
 */
async function takeFromPack(url, filename, label) {
  const pack = await loadPack(url);
  const entry = pack.entries[filename];
  if (!entry) {
    // 明確報出請求的名稱；靜默回傳空資料會讓 PDF 渲染出空白卻沒有任何線索
    const msg = `打包檔內找不到${label}「${filename}」（${url}，共 ${pack.count} 個項目）`;
    console.error('[pdfjs-assets]', msg);
    throw new Error(msg);
  }
  const [off, len] = entry;
  const start = pack.base + off;
  const end = start + len;
  if (end > pack.bytes.length) {
    const msg = `打包檔內${label}「${filename}」的範圍超出檔案結尾（${url}）`;
    console.error('[pdfjs-assets]', msg);
    throw new Error(msg);
  }
  // 一定要 slice 產生獨立副本：subarray 是共用 buffer 的視圖，
  // 透過 postMessage 傳給 worker 時會把整個 1 MB 打包檔一起複製過去。
  return pack.bytes.slice(start, end);
}

async function plainFetch(url, label, filename) {
  const res = await fetch(url);
  if (!res.ok) {
    const msg = `${label}「${filename}」載入失敗：${url}（HTTP ${res.status}）`;
    console.error('[pdfjs-assets]', msg);
    throw new Error(msg);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * PDF.js 的 BinaryDataFactory 實作（duck-typing；DOMBinaryDataFactory 沒有被 export，
 * 無法繼承，但 PDF.js 只會呼叫 fetch({kind, filename})）。
 */
export class PackedBinaryDataFactory {
  constructor({ cMapUrl = null, standardFontDataUrl = null, wasmUrl = null } = {}) {
    // 這三個是 PDF.js 傳進來的原始 URL 前綴；打包模式下只有 wasmUrl 會用到。
    this.cMapUrl = cMapUrl;
    this.standardFontDataUrl = standardFontDataUrl;
    this.wasmUrl = wasmUrl;
  }

  /**
   * @param {{kind:'cMapUrl'|'standardFontDataUrl'|'wasmUrl', filename:string}} req
   * @returns {Promise<Uint8Array>}
   */
  async fetch({ kind, filename }) {
    let bytes;
    let from;
    switch (kind) {
      case 'cMapUrl':
        from = ASSETS.cmapsPack;
        bytes = await takeFromPack(from, filename, 'CMap');
        break;
      case 'standardFontDataUrl':
        from = ASSETS.standardFontsPack;
        bytes = await takeFromPack(from, filename, '標準字型');
        break;
      case 'wasmUrl': {
        // wasm 沒有打包，原樣轉發到真實檔案
        from = `${this.wasmUrl || ASSETS.pdfWasm}${filename}`;
        bytes = await plainFetch(from, 'WebAssembly 模組', filename);
        break;
      }
      default: {
        const msg = `不支援的 PDF.js 資產類別「${kind}」（filename=${filename}）`;
        console.error('[pdfjs-assets]', msg);
        throw new Error(msg);
      }
    }
    requestLog.push({ kind, filename, bytes: bytes.length, from });
    return bytes;
  }
}

/** 測試用：把已載入的打包檔丟掉，讓下一次請求重新 fetch。 */
export function resetPackCache() {
  packs.clear();
}

/** 測試用：直接取出某個資產，供逐檔位元組比對。 */
export async function readPackedAsset(kind, filename) {
  if (kind === 'cMapUrl') return takeFromPack(ASSETS.cmapsPack, filename, 'CMap');
  if (kind === 'standardFontDataUrl') return takeFromPack(ASSETS.standardFontsPack, filename, '標準字型');
  throw new Error(`readPackedAsset 不支援 kind=${kind}`);
}

/** 測試用：列出打包檔內的所有名稱。 */
export async function listPackedAssets(kind) {
  const url = kind === 'cMapUrl' ? ASSETS.cmapsPack : ASSETS.standardFontsPack;
  const pack = await loadPack(url);
  return Object.keys(pack.entries);
}
