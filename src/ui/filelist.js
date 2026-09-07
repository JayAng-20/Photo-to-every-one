/**
 * filelist.js — 檔案清單、進度、狀態、單檔下載。
 *
 * 需求第 10 節：每個 URL.createObjectURL() 都要有對應的 revokeObjectURL()
 * （移除檔案時、更新縮圖時、清空全部時）。這個模組是所有 object URL 的唯一擁有者。
 */

import { FMT_LABEL, Fmt } from '../core/detect.js';
import { formatBytes } from './dropzone.js';

const STATUS_TEXT = {
  waiting: '等待中',
  running: '處理中',
  success: '成功',
  error: '失敗',
  unsupported: '不支援',
  cancelled: '已取消',
};

const $ = (id) => document.getElementById(id);

export class FileListView {
  constructor({ onRemove, onRetry, onClear }) {
    this.root = $('filelist');
    this.empty = $('filelist-empty');
    this.count = $('file-count');
    this.clearBtn = $('btn-clear');
    this.tpl = $('tpl-file-row');
    this.live = $('live');
    this.onRemove = onRemove;
    this.onRetry = onRetry;
    this.clearBtn.addEventListener('click', () => onClear());
  }

  announce(text) {
    if (this.live) this.live.textContent = text;
  }

  _row(item) { return item.el; }

  add(item) {
    const frag = this.tpl.content.cloneNode(true);
    const li = frag.querySelector('.file-row');
    li.dataset.id = item.id;
    item.el = li;
    li.querySelector('.btn-remove').addEventListener('click', () => this.onRemove(item));
    li.querySelector('.btn-retry').addEventListener('click', () => this.onRetry(item));
    li.querySelector('.btn-download').addEventListener('click', () => {
      const first = item.outputs[0];
      if (first) triggerDownload(first.url, first.name);
    });
    this.root.appendChild(frag);
    this.update(item);
  }

  update(item) {
    const li = this._row(item);
    if (!li) return;
    li.dataset.status = item.status;

    li.querySelector('.file-name').textContent = item.name;

    const bits = [formatBytes(item.size), FMT_LABEL[item.format] || '未知格式'];
    if (item.meta && item.meta.pages) bits.push(`${item.meta.pages} 頁`);
    else if (item.meta && item.meta.width) bits.push(`${item.meta.width} × ${item.meta.height} 像素`);
    else if (item.probing) bits.push('讀取中…');
    li.querySelector('.file-meta').textContent = bits.join('　·　');

    const noteEl = li.querySelector('.file-note');
    const notes = [];
    if (item.det && item.det.mismatch) {
      notes.push(`實際格式為 ${FMT_LABEL[item.format]}（副檔名與內容不符，已依內容處理）`);
    } else if (item.det && item.det.extAlias) {
      const brand = item.det.brand ? `，brand: ${item.det.brand}` : '';
      notes.push(`實際格式為 ${FMT_LABEL[item.format]}（依檔案內容判定${brand}）`);
    }
    if (item.note) notes.push(item.note);
    if (item.error) notes.push(item.error);
    if (notes.length) {
      noteEl.textContent = notes.join('　');
      noteEl.hidden = false;
    } else {
      noteEl.hidden = true;
      noteEl.textContent = '';
    }

    li.querySelector('.bar-fill').style.width = `${Math.round((item.progress || 0) * 100)}%`;
    li.querySelector('.status-text').textContent = STATUS_TEXT[item.status] || item.status;

    li.querySelector('.btn-download').hidden = !(item.status === 'success' && item.outputs.length === 1);
    li.querySelector('.btn-retry').hidden = !(item.status === 'error' || item.status === 'cancelled');
  }

  setThumb(item, blob) {
    const li = this._row(item);
    if (!li || !blob) return;
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);   // 更新縮圖時先釋放舊的
    item.thumbUrl = URL.createObjectURL(blob);
    const box = li.querySelector('.thumb');
    box.innerHTML = '';
    const img = document.createElement('img');
    img.src = item.thumbUrl;
    img.alt = '';
    box.appendChild(img);
  }

  addOutput(item, name, blob) {
    const url = URL.createObjectURL(blob);
    item.outputs.push({ name, blob, url });
    const li = this._row(item);
    if (!li) return;
    const ul = li.querySelector('.outputs');
    const el = document.createElement('li');
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.textContent = `⬇ ${name}`;
    el.appendChild(a);
    ul.appendChild(el);
  }

  clearOutputs(item) {
    for (const o of item.outputs) URL.revokeObjectURL(o.url);
    item.outputs.length = 0;
    const li = this._row(item);
    if (li) li.querySelector('.outputs').innerHTML = '';
  }

  remove(item) {
    this.clearOutputs(item);
    if (item.thumbUrl) { URL.revokeObjectURL(item.thumbUrl); item.thumbUrl = null; }
    const li = this._row(item);
    if (li) li.remove();
    item.el = null;
  }

  syncChrome(items) {
    const n = items.length;
    this.empty.hidden = n > 0;
    this.clearBtn.hidden = n === 0;
    this.count.hidden = n === 0;
    this.count.textContent = `${n} 個檔案`;
  }
}

export function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export { Fmt };
