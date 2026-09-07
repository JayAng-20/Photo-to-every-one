/**
 * zip.js — 批次輸出的 ZIP 打包（fflate）。
 *
 * 需求第 4.2 節：使用 STORE（不壓縮）模式——輸入本來就是壓縮格式，再壓一次只是
 * 浪費時間。ZipPassThrough 就是 STORE。
 * 需求第 10 節：邊轉邊寫入的串流方式，不要等全部轉完才開始打包。
 */

import { Zip, ZipPassThrough } from '../../vendor/fflate/fflate.js';
import { AppError, ErrorCode } from './errors.js';

export class StreamingZip {
  constructor() {
    this.chunks = [];
    this.bytes = 0;
    this.names = new Map();
    this.closed = false;
    this.finished = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this.zip = new Zip((err, data, final) => {
      if (err) { this._reject(new AppError(ErrorCode.ENCODE_FAILED, err)); return; }
      if (data && data.length) { this.chunks.push(data); this.bytes += data.length; }
      if (final) this._resolve();
    });
    // 沒有 catch 的 promise 會在取消時噴 unhandled rejection
    this.finished.catch(() => {});
  }

  /** 同名檔案自動加序號，避免 ZIP 內重複 */
  _uniqueName(name) {
    if (!this.names.has(name)) { this.names.set(name, 1); return name; }
    const n = this.names.get(name);
    this.names.set(name, n + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)}_${n}${name.slice(dot)}` : `${name}_${n}`;
  }

  /**
   * 立刻把一個輸出檔寫進 ZIP 串流。
   * @param {string} name
   * @param {Blob} blob
   */
  async add(name, blob) {
    if (this.closed) throw new AppError(ErrorCode.ENCODE_FAILED, 'zip already closed');
    const entry = new ZipPassThrough(this._uniqueName(name));
    this.zip.add(entry);
    const buf = new Uint8Array(await blob.arrayBuffer());
    entry.push(buf, true);
  }

  get count() { return this.names.size; }

  /** @returns {Promise<Blob>} */
  async finish() {
    if (this.closed) throw new AppError(ErrorCode.ENCODE_FAILED, 'zip already closed');
    this.closed = true;
    this.zip.end();
    await this.finished;
    return new Blob(this.chunks, { type: 'application/zip' });
  }

  abort() {
    this.closed = true;
    this.chunks.length = 0;
    try { this.zip.terminate(); } catch { /* 忽略 */ }
    this._reject(new AppError(ErrorCode.CANCELLED));
  }
}

/** 一次性打包（給「全部下載」用；內部仍是串流寫入） */
export async function zipAll(entries) {
  const z = new StreamingZip();
  for (const { name, blob } of entries) await z.add(name, blob);
  return z.finish();
}
