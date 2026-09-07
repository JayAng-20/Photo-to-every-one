/**
 * dialog.js — 確認對話框（需求 9.5 的「超出 canvas 上限」確認提示）。
 *
 * 不能只依賴 <dialog> 的 close 事件：實測在背景／隱藏分頁中，
 * 用 form method="dialog" 關閉對話框時 close 事件不會即時派送，
 * 會讓等待中的 Promise 永遠停在那裡。因此這裡直接綁兩顆按鈕的 click，
 * 並保留 cancel（Esc）與 close 事件作為備援。
 */

const dlg = () => document.getElementById('confirm-dialog');

/**
 * @param {{title:string, body:string, okLabel?:string, cancelLabel?:string}} opts
 * @returns {Promise<boolean>} true = 使用者選了「繼續」
 */
export function confirmDialog(opts) {
  const d = dlg();
  if (!d || typeof d.showModal !== 'function') {
    return Promise.resolve(window.confirm(`${opts.title}\n\n${opts.body}`));
  }

  d.querySelector('#confirm-title').textContent = opts.title;
  d.querySelector('#confirm-body').textContent = opts.body;
  const ok = d.querySelector('#confirm-ok');
  const cancel = d.querySelector('button[value="cancel"]');
  ok.textContent = opts.okLabel || '繼續';
  cancel.textContent = opts.cancelLabel || '取消';

  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      d.removeEventListener('cancel', onEsc);
      d.removeEventListener('close', onClose);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (d.open) { try { d.close(value ? 'ok' : 'cancel'); } catch { /* 忽略 */ } }
      resolve(value);
    };
    function onOk(e) { e.preventDefault(); finish(true); }
    function onCancel(e) { e.preventDefault(); finish(false); }
    function onEsc() { finish(false); }
    function onClose() { finish(d.returnValue === 'ok'); }

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    d.addEventListener('cancel', onEsc);
    d.addEventListener('close', onClose);

    d.returnValue = 'cancel';
    d.showModal();
    ok.focus();
  });
}
