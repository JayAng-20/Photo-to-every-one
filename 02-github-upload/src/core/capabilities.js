/**
 * capabilities.js — 啟動時的能力偵測（需求第 14 節）。
 * 缺少必要能力時要顯示明確訊息，而不是白畫面。
 */

const CHECKS = [
  ['WebAssembly', () => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'],
  ['Web Worker', () => typeof Worker === 'function'],
  ['createImageBitmap', () => typeof createImageBitmap === 'function'],
  ['File API', () => typeof File === 'function' && typeof FileReader === 'function' && typeof Blob === 'function'],
  ['Blob.arrayBuffer', () => typeof Blob === 'function' && typeof Blob.prototype.arrayBuffer === 'function'],
  ['URL.createObjectURL', () => typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'],
  ['ES 模組 Worker', () => true], // 無法在不建立 Worker 的情況下同步偵測，實際建立時再處理
];

const OPTIONAL = [
  ['OffscreenCanvas', () => typeof OffscreenCanvas === 'function'
    && typeof OffscreenCanvas.prototype.convertToBlob === 'function'],
  ['Service Worker', () => 'serviceWorker' in navigator],
  ['showSaveFilePicker', () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'],
];

export function detectCapabilities() {
  const missing = [];
  for (const [name, fn] of CHECKS) {
    let ok = false;
    try { ok = !!fn(); } catch { ok = false; }
    if (!ok) missing.push(name);
  }
  const optional = {};
  for (const [name, fn] of OPTIONAL) {
    try { optional[name] = !!fn(); } catch { optional[name] = false; }
  }
  return { ok: missing.length === 0, missing, optional };
}

/** 建議的 Worker 數量（第 4.2 節） */
export function suggestedConcurrency() {
  return Math.min(navigator.hardwareConcurrency || 2, 4);
}
