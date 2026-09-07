/**
 * dropzone.js — 拖放與檔案選擇。
 *
 * 需求第 11 節的三個狀態：一般、拖曳懸停（明顯視覺回饋）、拖入不支援格式的拒絕提示。
 * 無障礙：拖放區有對應的 <input type="file">，可用鍵盤操作。
 */

export const LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,   // 單檔 100 MB
  maxFiles: 100,                     // 單批 100 個檔案
  maxBatchBytes: 1024 * 1024 * 1024, // 單批總計 1 GB
};

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function initDropzone({ onFiles }) {
  const zone = document.getElementById('dropzone');
  const input = document.getElementById('file-input');
  const reject = document.getElementById('dropzone-reject');
  let depth = 0;
  let rejectTimer = 0;

  const clearReject = () => {
    zone.classList.remove('is-reject');
    reject.hidden = true;
    reject.textContent = '';
  };

  const showReject = (text) => {
    zone.classList.add('is-reject');
    reject.textContent = text;
    reject.hidden = false;
    clearTimeout(rejectTimer);
    rejectTimer = setTimeout(clearReject, 5000);
  };

  const setOver = (on) => zone.classList.toggle('is-over', on);

  ['dragenter', 'dragover'].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (ev === 'dragenter') depth++;
      clearReject();
      setOver(true);
    });
  });

  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (depth === 0) setOver(false);
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    setOver(false);
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    if (files.length === 0) {
      showReject('沒有偵測到檔案。資料夾與網頁連結無法直接拖入，請拖入檔案本身。');
      return;
    }
    onFiles(files);
  });

  // 整頁攔截，避免拖到別的地方時瀏覽器直接開啟檔案
  ['dragover', 'drop'].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      if (!zone.contains(e.target)) e.preventDefault();
    });
  });

  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';           // 允許重複選同一個檔案
    if (files.length) onFiles(files);
  });

  return { showReject, clearReject };
}
