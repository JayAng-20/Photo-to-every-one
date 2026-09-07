/**
 * main.js — 進入點與狀態管理。
 *
 * 純前端、零上傳：所有函式庫與 WASM 都與本站一起部署，轉檔過程不會對外連線。
 */

import { detectFile, rejectionFor, Fmt, FMT_LABEL, READABLE } from './core/detect.js';
import { AppError, ErrorCode, messageFor } from './core/errors.js';
import { detectCapabilities, suggestedConcurrency } from './core/capabilities.js';
import { probeCanvasLimits } from './core/canvaslimits.js';
import { WorkerPool } from './core/workerpool.js';
import { StreamingZip } from './core/zip.js';
import {
  runConversion, isSupported, unsupportedReason, defaultOutputFor, EXT, baseName,
} from './core/pipeline.js';
import { pdfPageOutputPixels, suggestDpiWithinLimits, formatPixels, imageOutputPixels } from './core/resolution.js';
import { openPdf } from './codecs/pdf-decode.js';
import { initDropzone, LIMITS, formatBytes } from './ui/dropzone.js';
import { FileListView, triggerDownload } from './ui/filelist.js';
import { SettingsPanel } from './ui/settings.js';
import { confirmDialog } from './ui/dialog.js';
import { ENABLED as HEIC_ENCODE_ENABLED } from './codecs/heic-encode.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 狀態                                                                */
/* ------------------------------------------------------------------ */

const state = {
  items: [],
  seq: 0,
  running: false,
  cancelled: false,
  pool: null,
  limits: null,
  zip: null,
  zipChain: Promise.resolve(),
  outputCount: 0,
  batchOutputs: [],
};

let listView;
let settings;
let dz;

/* ------------------------------------------------------------------ */
/* 啟動                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  const caps = detectCapabilities();
  if (!caps.ok) {
    const banner = $('capability-error');
    banner.textContent = `${messageFor(ErrorCode.BROWSER_UNSUPPORTED)}（缺少：${caps.missing.join('、')}）`;
    banner.hidden = false;
  }

  listView = new FileListView({
    onRemove: removeItem,
    onRetry: retryItem,
    onClear: clearAll,
  });
  settings = new SettingsPanel({ onChange: onSettingsChange });
  dz = initDropzone({ onFiles: addFiles });

  $('btn-convert').addEventListener('click', startConversion);
  $('btn-cancel').addEventListener('click', cancelConversion);
  $('btn-zip').addEventListener('click', downloadZip);

  $('env-note').textContent =
    `並行度 ${suggestedConcurrency()} 個 Worker`
    + `${caps.optional.OffscreenCanvas ? '．OffscreenCanvas 可用' : '．OffscreenCanvas 不可用（改用主執行緒 canvas）'}`
    + `${HEIC_ENCODE_ENABLED ? '' : '．HEIF/HEIC 輸出停用'}`;

  // canvas 上限用執行期探測，不寫死數字
  probeCanvasLimits().then((limits) => {
    state.limits = limits;
    settings.setLimits(limits);
    $('env-note').textContent += `．繪圖上限 ${limits.maxDimension.toLocaleString('zh-TW')} 像素邊長 / `
      + `${limits.maxArea.toLocaleString('zh-TW')} 像素面積${limits.ceiling ? '（保守值）' : ''}`;
  });

  registerServiceWorker();
  syncUi();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const url = new URL('sw.js', document.baseURI);
  navigator.serviceWorker.register(url, { scope: './' }).catch((e) => {
    console.warn('[sw] 註冊失敗（不影響轉檔功能）', e);
  });
}

function pool() {
  if (!state.pool) state.pool = new WorkerPool(suggestedConcurrency());
  return state.pool;
}

/* ------------------------------------------------------------------ */
/* 加入檔案                                                            */
/* ------------------------------------------------------------------ */

async function addFiles(files) {
  const problems = [];
  let totalBytes = state.items.reduce((a, it) => a + it.size, 0);

  for (const file of files) {
    if (state.items.length >= LIMITS.maxFiles) {
      problems.push(messageFor(ErrorCode.BATCH_TOO_MANY));
      break;
    }
    if (file.size > LIMITS.maxFileBytes) {
      problems.push(`「${file.name}」${formatBytes(file.size)}：${messageFor(ErrorCode.FILE_TOO_LARGE)}`);
      continue;
    }
    if (totalBytes + file.size > LIMITS.maxBatchBytes) {
      problems.push(messageFor(ErrorCode.BATCH_TOO_LARGE));
      break;
    }

    let det;
    try {
      det = await detectFile(file, file.name);
    } catch (e) {
      problems.push(`「${file.name}」：${messageFor(ErrorCode.CORRUPT_FILE)}`);
      continue;
    }
    const reject = rejectionFor(det);
    if (reject) {
      problems.push(`「${file.name}」：${reject.message}`);
      continue;
    }

    totalBytes += file.size;
    const item = {
      id: `f${++state.seq}`,
      file,
      name: file.name || `檔案${state.seq}`,
      size: file.size,
      det,
      format: det.format,
      meta: null,
      probing: true,
      status: 'waiting',
      progress: 0,
      note: null,
      error: null,
      outputs: [],
      thumbUrl: null,
      el: null,
    };
    state.items.push(item);
    listView.add(item);
    probeItem(item);
  }

  if (problems.length) dz.showReject(problems.join('　/　'));
  syncUi();
  if (state.items.length) {
    settings.suggestFormat(defaultOutputFor(state.items[0].format));
    listView.announce(`已加入 ${state.items.length} 個檔案`);
  }
}

/** 讀取檔案的尺寸／頁數，並送一張縮圖上來 */
async function probeItem(item) {
  try {
    if (item.format === Fmt.PDF) {
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const pdf = await openPdf(bytes);
      try {
        const sizePt = await pdf.pageSizePt(1);
        item.meta = { pages: pdf.numPages, firstPageSizePt: sizePt };
        item.probing = false;
        listView.update(item);
        syncUi();
        // 縮圖：第一頁縮到 96px
        const scaleDpi = Math.max(4, (96 / Math.max(sizePt.width, sizePt.height)) * 72);
        const rgba = await pdf.renderPage(1, scaleDpi, state.limits);
        const res = await pool().run('thumbnail', { image: rgba, maxEdge: 96 }, [rgba.data.buffer]);
        if (res.blob) listView.setThumb(item, res.blob);
      } finally {
        await pdf.destroy();
      }
    } else if (item.format === Fmt.HEIC) {
      // HEIC 解碼較慢：解完先送一張小縮圖上來，不讓使用者盯著空白
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const res = await pool().run('probe-heic', { bytes, thumbEdge: 96 }, [bytes.buffer]);
      item.meta = { width: res.width, height: res.height };
      item.probing = false;
      const notes = [];
      if (res.imageCount > 1) notes.push(`此檔含 ${res.imageCount} 張影像，已取主影像`);
      if (res.appliedOrientation && res.appliedOrientation !== 1) {
        notes.push(`已依 EXIF 方向 ${res.appliedOrientation} 旋轉`);
      } else if (res.containerTransform) {
        notes.push('已套用容器旋轉屬性（irot/imir）');
      }
      if (notes.length) item.note = notes.join('　');
      item.decodePath = res.decodePath;
      item.heicDiag = res;
      listView.update(item);
      syncUi();
      if (res.thumb) listView.setThumb(item, res.thumb);
    } else {
      const bmp = await createImageBitmap(item.file);
      item.meta = { width: bmp.width, height: bmp.height };
      item.probing = false;
      listView.update(item);
      syncUi();
      const c = document.createElement('canvas');
      const k = 96 / Math.max(bmp.width, bmp.height, 1);
      c.width = Math.max(1, Math.round(bmp.width * Math.min(1, k)));
      c.height = Math.max(1, Math.round(bmp.height * Math.min(1, k)));
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      await new Promise((r) => c.toBlob((b) => { if (b) listView.setThumb(item, b); r(); }, 'image/png'));
      c.width = 1; c.height = 1;
    }
  } catch (e) {
    item.probing = false;
    const err = e instanceof AppError ? e : new AppError(ErrorCode.CORRUPT_FILE, e);
    item.status = 'error';
    item.error = err.message;
    console.error('[probe]', item.name, e);
  }
  listView.update(item);
  syncUi();
}

function removeItem(item) {
  const i = state.items.indexOf(item);
  if (i >= 0) state.items.splice(i, 1);
  listView.remove(item);
  syncUi();
}

function clearAll() {
  for (const item of [...state.items]) listView.remove(item);
  state.items.length = 0;
  resetBatchOutputs();
  syncUi();
  listView.announce('已清除全部檔案');
}

async function retryItem(item) {
  if (state.running) return;
  listView.clearOutputs(item);
  item.status = 'waiting';
  item.progress = 0;
  item.error = null;
  listView.update(item);
  await runBatch([item]);
}

/* ------------------------------------------------------------------ */
/* UI 同步                                                             */
/* ------------------------------------------------------------------ */

function onSettingsChange(s) {
  const convertBtn = $('btn-convert');
  const ready = state.items.length > 0 && s.valid && !state.running;
  convertBtn.disabled = !ready;

  // 每一列標出「這個組合不支援」
  for (const item of state.items) {
    if (item.status === 'waiting' || item.status === 'unsupported') {
      const ok = isSupported(item.format, s.format, HEIC_ENCODE_ENABLED);
      if (!ok) {
        item.status = 'unsupported';
        item.error = unsupportedReason(item.format, s.format, HEIC_ENCODE_ENABLED);
      } else if (item.status === 'unsupported') {
        item.status = 'waiting';
        item.error = null;
      }
      listView.update(item);
    }
  }
}

function syncUi() {
  listView.syncChrome(state.items);
  settings.setInputFormats(state.items.map((i) => i.format), state.items[0] || null);
  settings.setItemCount(state.items.length);
}

/* ------------------------------------------------------------------ */
/* 轉換                                                                */
/* ------------------------------------------------------------------ */

/** 需求 9.5：超過 canvas 上限時先跳確認，不得自動降解析度 */
async function preflight(items, s) {
  const limits = state.limits;
  if (!limits) return { ok: true, dpi: s.dpi, maxEdge: s.maxEdgeEnabled ? s.maxEdge : null };

  if (s.format !== Fmt.PDF) {
    // PDF → 影像：解析度直接決定像素尺寸
    let worst = null;
    for (const item of items) {
      if (item.format !== Fmt.PDF || !item.meta || !item.meta.firstPageSizePt) continue;
      const sug = suggestDpiWithinLimits(item.meta.firstPageSizePt, s.dpi, limits);
      if (sug && (!worst || sug.suggested < worst.suggested)) worst = sug;
    }
    if (worst) {
      const ok = await confirmDialog({
        title: '解析度超出瀏覽器繪圖上限',
        body: `此設定會產生 ${formatPixels(worst.wouldBe)}，超出瀏覽器繪圖上限`
          + `（邊長 ${limits.maxDimension.toLocaleString('zh-TW')}、面積 ${limits.maxArea.toLocaleString('zh-TW')} 像素）。`
          + `是否改用 ${worst.suggested} 像素/英寸（約 ${formatPixels(worst.alt)}）繼續？`,
        okLabel: `使用 ${worst.suggested} dpi 繼續`,
        cancelLabel: '取消',
      });
      if (!ok) return { ok: false };
      return { ok: true, dpi: worst.suggested, maxEdge: s.maxEdgeEnabled ? s.maxEdge : null, note: `本次以 ${worst.suggested} dpi 執行` };
    }

    // 影像 → 影像：來源像素本身可能就超過上限
    let over = null;
    for (const item of items) {
      if (item.format === Fmt.PDF || !item.meta || !item.meta.width) continue;
      const px = imageOutputPixels({ width: item.meta.width, height: item.meta.height },
        s.maxEdgeEnabled ? s.maxEdge : null);
      if (px.width > limits.maxDimension || px.height > limits.maxDimension
        || px.width * px.height > limits.maxArea) {
        if (!over || px.width * px.height > over.px.width * over.px.height) over = { item, px };
      }
    }
    if (over) {
      const side = Math.min(limits.maxDimension, Math.floor(Math.sqrt(limits.maxArea)));
      const alt = imageOutputPixels({ width: over.item.meta.width, height: over.item.meta.height }, side);
      const ok = await confirmDialog({
        title: '影像尺寸超出瀏覽器繪圖上限',
        body: `「${over.item.name}」的 ${formatPixels(over.px)} 超出瀏覽器繪圖上限。`
          + `是否改用最長邊 ${side.toLocaleString('zh-TW')} 像素（約 ${formatPixels(alt)}）繼續？`,
        okLabel: `限制最長邊 ${side} 像素繼續`,
        cancelLabel: '取消',
      });
      if (!ok) return { ok: false };
      return { ok: true, dpi: s.dpi, maxEdge: side, note: `本次限制最長邊 ${side} 像素` };
    }
  }
  return { ok: true, dpi: s.dpi, maxEdge: s.maxEdgeEnabled ? s.maxEdge : null };
}

function resetBatchOutputs() {
  for (const o of state.batchOutputs) URL.revokeObjectURL(o.url);
  state.batchOutputs.length = 0;
  $('batch-outputs').innerHTML = '';
  $('btn-zip').hidden = true;
  state.zip = null;
  state.zipBlob = null;
  state.outputCount = 0;
}

async function startConversion() {
  const target = state.items.filter((i) => i.status !== 'unsupported' || true);
  await runBatch(target);
}

async function runBatch(items) {
  if (state.running) return;
  const s = settings.value();
  if (!s.valid) return;

  const pre = await preflight(items, s);
  if (!pre.ok) {
    resetBatchOutputs();
    $('batch-progress').hidden = false;
    $('batch-bar').style.width = '0%';
    $('batch-text').textContent = '已取消，沒有產生任何輸出檔';
    listView.announce('已取消，沒有產生任何輸出檔');
    return;
  }
  const effective = { ...s, dpi: pre.dpi, maxEdgeEnabled: pre.maxEdge != null, maxEdge: pre.maxEdge, limits: state.limits };

  state.running = true;
  state.cancelled = false;
  resetBatchOutputs();
  state.zip = new StreamingZip();
  state.zipChain = Promise.resolve();

  $('btn-convert').disabled = true;
  $('btn-cancel').hidden = false;
  $('btn-clear').disabled = true;
  $('batch-progress').hidden = false;
  const bar = $('batch-bar');
  const text = $('batch-text');
  text.textContent = pre.note ? `轉換中…（${pre.note}）` : '轉換中…';

  for (const item of items) {
    if (item.status !== 'unsupported') {
      listView.clearOutputs(item);
      item.status = 'waiting';
      item.progress = 0;
      item.error = null;
      listView.update(item);
    }
  }

  const total = items.length;
  const updateBatch = () => {
    const sum = items.reduce((a, it) => a + (it.progress || 0), 0);
    bar.style.width = `${Math.round((sum / Math.max(1, total)) * 100)}%`;
  };

  const queueZip = (name, blob) => {
    state.outputCount++;
    state.zipChain = state.zipChain.then(() => state.zip && state.zip.add(name, blob)).catch(() => {});
  };

  const hooks = {
    onStart(item) { item.status = 'running'; item.progress = 0.02; listView.update(item); updateBatch(); },
    onProgress(item, v) { item.progress = Math.max(item.progress, Math.min(0.99, v)); listView.update(item); updateBatch(); },
    onOutput(item, name, blob) { listView.addOutput(item, name, blob); queueZip(name, blob); },
    onBatchOutput(name, blob) { addBatchOutput(name, blob); queueZip(name, blob); },
    onDone(item, info) {
      item.status = 'success';
      item.progress = 1;
      if (info && info.mergedInto) item.note = `已併入「${info.mergedInto}」`;
      listView.update(item);
      updateBatch();
    },
    onError(item, err) {
      item.status = 'error';
      item.error = err.message;
      item.progress = 1;
      listView.update(item);
      updateBatch();
    },
    onUnsupported(item, reason) {
      item.status = 'unsupported';
      item.error = reason;
      item.progress = 0;
      listView.update(item);
    },
    onCancelled(item) { item.status = 'cancelled'; listView.update(item); },
    onWarning(item, w) { item.note = w; listView.update(item); },
  };

  try {
    await runConversion({
      items,
      settings: effective,
      pool: pool(),
      limits: state.limits,
      heicEncodeEnabled: HEIC_ENCODE_ENABLED,
      hooks,
      isCancelled: () => state.cancelled,
    });
  } catch (e) {
    console.error('[batch]', e);
  }

  await state.zipChain;
  // 整批完成後 terminate 全部 Worker，讓 WASM heap 真的還給瀏覽器
  if (state.pool) { state.pool.shutdown(); }

  state.running = false;
  $('btn-cancel').hidden = true;
  $('btn-clear').disabled = false;
  $('btn-convert').disabled = state.items.length === 0 || !settings.value().valid;
  bar.style.width = '100%';

  const okCount = items.filter((i) => i.status === 'success').length;
  const failCount = items.filter((i) => i.status === 'error' || i.status === 'unsupported').length;
  text.textContent = state.cancelled
    ? `已取消：取消前已產生的 ${state.outputCount} 個輸出檔仍保留在清單中`
    : `完成：${okCount} 個成功${failCount ? `、${failCount} 個失敗或不支援` : ''}，共 ${state.outputCount} 個輸出檔`;
  listView.announce(text.textContent);

  if (state.outputCount >= 2 && !state.cancelled) $('btn-zip').hidden = false;
}

function addBatchOutput(name, blob) {
  const url = URL.createObjectURL(blob);
  state.batchOutputs.push({ name, blob, url });
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.textContent = `⬇ ${name}`;
  li.appendChild(a);
  $('batch-outputs').appendChild(li);
}

function cancelConversion() {
  state.cancelled = true;
  if (state.pool) state.pool.cancelAll();
  if (state.zip) { try { state.zip.abort(); } catch { /* 忽略 */ } state.zip = null; }
  $('btn-cancel').hidden = true;
  listView.announce('已送出取消，已完成的結果會保留');
}

async function downloadZip() {
  const btn = $('btn-zip');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '打包中…';
  try {
    if (!state.zipBlob) {
      if (!state.zip) throw new AppError(ErrorCode.ENCODE_FAILED, 'no zip');
      state.zipBlob = await state.zip.finish();
      state.zipUrl = URL.createObjectURL(state.zipBlob);
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    triggerDownload(state.zipUrl, `轉換結果_${stamp}.zip`);
  } catch (e) {
    console.error('[zip]', e);
    dz.showReject('打包 ZIP 時發生問題，請改用單檔下載。');
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

window.addEventListener('beforeunload', () => {
  if (state.pool) state.pool.destroy();
});

// 給測試與除錯用（不會送出任何資料）
window.__converter = { state, get settings() { return settings && settings.value(); } };

boot();

export { FMT_LABEL, READABLE, EXT, baseName, pdfPageOutputPixels };
