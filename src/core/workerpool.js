/**
 * workerpool.js — Worker 池與任務佇列。
 *
 * 需求第 10 節：
 *  - Worker 用完歸還池中重用
 *  - 整批完成後 terminate() 全部 Worker，釋放 WASM heap
 *  - 取消時清空佇列並 terminate 進行中的 Worker
 *  - 同時在記憶體中的 ImageData 數量上限 = Worker 數量（由佇列的並行度保證）
 */

import { fromWire, AppError, ErrorCode } from './errors.js';
import { suggestedConcurrency } from './capabilities.js';

const WORKER_URL = new URL('../workers/convert.worker.js', import.meta.url);

/**
 * 單一任務的看門狗上限。正常情況下最慢的任務（大尺寸 HEIC 編碼、超大 PDF 頁面）
 * 也在十秒等級，這裡取一個非常寬鬆的值；只有在第三方解碼器真的卡死時才會觸發，
 * 避免整批永遠停在「處理中」。
 */
const TASK_TIMEOUT_MS = 180000;

export class WorkerPool {
  constructor(size = suggestedConcurrency()) {
    this.size = Math.max(1, size);
    /** @type {{worker:Worker, busy:boolean, task:object|null}[]} */
    this.slots = [];
    this.queue = [];
    this.seq = 0;
    this.destroyed = false;
  }

  get concurrency() { return this.size; }

  _spawn() {
    let worker;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch (e) {
      throw new AppError(ErrorCode.BROWSER_UNSUPPORTED, e);
    }
    const slot = { worker, busy: false, task: null, timer: null };
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      const task = slot.task;
      if (!task || msg.id !== task.id) return;
      if (msg.progress) {
        if (task.onProgress) task.onProgress(msg.progress);
        this._arm(slot);        // 有進度就重新計時
        return;
      }
      this._disarm(slot);
      slot.task = null;
      slot.busy = false;
      if (msg.ok) task.resolve(msg.result);
      else task.reject(fromWire(msg.error));
      this._drain();
    };
    worker.onerror = (e) => {
      console.error('[workerpool] worker error', e && e.message);
      this._disarm(slot);
      const task = slot.task;
      slot.task = null;
      slot.busy = false;
      // 這個 worker 可能已經壞了，換一個新的
      try { worker.terminate(); } catch { /* 忽略 */ }
      const idx = this.slots.indexOf(slot);
      if (idx >= 0) this.slots.splice(idx, 1);
      if (task) task.reject(new AppError(ErrorCode.WORKER_FAILED, e && e.message));
      this._drain();
    };
    this.slots.push(slot);
    return slot;
  }

  /** 啟動／重設某個 slot 的看門狗 */
  _arm(slot) {
    this._disarm(slot);
    slot.timer = setTimeout(() => {
      const task = slot.task;
      console.error('[workerpool] 任務逾時，重建 worker', task && task.type);
      slot.task = null;
      slot.busy = false;
      try { slot.worker.terminate(); } catch { /* 忽略 */ }
      const idx = this.slots.indexOf(slot);
      if (idx >= 0) this.slots.splice(idx, 1);
      if (task) task.reject(new AppError(ErrorCode.WORKER_FAILED, `task timeout: ${task.type}`));
      this._drain();
    }, TASK_TIMEOUT_MS);
  }

  _disarm(slot) {
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
  }

  _freeSlot() {
    const idle = this.slots.find((s) => !s.busy);
    if (idle) return idle;
    if (this.slots.length < this.size) return this._spawn();
    return null;
  }

  _drain() {
    if (this.destroyed) return;
    while (this.queue.length) {
      const slot = this._freeSlot();
      if (!slot) return;
      const task = this.queue.shift();
      if (task.cancelled) continue;
      slot.busy = true;
      slot.task = task;
      this._arm(slot);
      try {
        slot.worker.postMessage({ id: task.id, type: task.type, payload: task.payload }, task.transfer || []);
      } catch (e) {
        this._disarm(slot);
        slot.busy = false;
        slot.task = null;
        task.reject(new AppError(ErrorCode.WORKER_FAILED, e));
      }
    }
  }

  /**
   * @param {string} type
   * @param {object} payload
   * @param {Transferable[]} [transfer] 用 Transferable 傳送，不複製
   * @param {(p:{stage:string,value:number})=>void} [onProgress]
   */
  run(type, payload, transfer = [], onProgress = null) {
    if (this.destroyed) return Promise.reject(new AppError(ErrorCode.CANCELLED));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.seq, type, payload, transfer, onProgress, resolve, reject, cancelled: false });
      this._drain();
    });
  }

  /** 取消所有排隊中與進行中的任務，並 terminate 全部 worker（釋放 WASM heap）。 */
  cancelAll() {
    const err = new AppError(ErrorCode.CANCELLED);
    for (const t of this.queue) { t.cancelled = true; t.reject(err); }
    this.queue.length = 0;
    for (const slot of this.slots) {
      this._disarm(slot);
      if (slot.task) slot.task.reject(err);
      try { slot.worker.terminate(); } catch { /* 忽略 */ }
    }
    this.slots.length = 0;
  }

  /** 整批完成後呼叫：terminate 全部 worker，讓 WASM 記憶體真的還給瀏覽器。 */
  shutdown() {
    for (const slot of this.slots) {
      this._disarm(slot);
      try { slot.worker.terminate(); } catch { /* 忽略 */ }
    }
    this.slots.length = 0;
  }

  destroy() {
    this.destroyed = true;
    this.cancelAll();
  }
}
