/**
 * settings.js — 輸出設定面板（格式、解析度、品質、PDF 版面）。
 *
 * 解析度區塊參照 macOS 內建「輸出為」對話框：格式下拉選單 + 可自由輸入的數值欄位
 * + 單位下拉（像素/英寸、像素/公分）。切換單位時數值自動換算並顯示換算後的結果。
 * 需求第 9 節。
 */

import {
  Unit, UNIT_LABEL, DPI_MIN, DPI_MAX, validate, dpiToPpcm, displayRound,
  pdfPageOutputPixels, imageOutputPixels, imagePhysicalSizePt, formatPixels, PAGE_SIZES,
} from '../core/resolution.js';
import { Fmt, FMT_LABEL } from '../core/detect.js';
import { ENABLED as HEIC_ENCODE_ENABLED, DISABLED_REASON, LIMITATIONS as HEIC_LIMITATIONS } from '../codecs/heic-encode.js';

const $ = (id) => document.getElementById(id);
const PT_TO_MM = 25.4 / 72;

export class SettingsPanel {
  constructor({ onChange }) {
    this.onChange = onChange || (() => {});
    this.unit = Unit.DPI;
    /** 內部一律以 dpi 保存完整精度 */
    this.dpi = 150;
    this.valid = true;
    this.userTouchedFormat = false;
    this.limits = null;
    this.el = {
      format: $('out-format'),
      dpiValue: $('dpi-value'),
      dpiUnit: $('dpi-unit'),
      dpiError: $('dpi-error'),
      dpiEstimate: $('dpi-estimate'),
      dpiHint: $('dpi-hint'),
      formatNote: $('format-note'),
      quality: $('quality'),
      qualityOut: $('quality-out'),
      fieldQuality: $('field-quality'),
      fieldBackground: $('field-background'),
      bgCustom: $('bg-custom'),
      fieldMaxEdge: $('field-maxedge'),
      maxEdgeOn: $('maxedge-on'),
      maxEdge: $('maxedge'),
      fieldPdf: $('field-pdf'),
      pdfPageSize: $('pdf-pagesize'),
      pdfOrientation: $('pdf-orientation'),
      pdfFit: $('pdf-fit'),
      pdfAspect: $('pdf-aspect'),
      fieldPageRange: $('field-pagerange'),
      pageRangeMode: $('pagerange-mode'),
      pageRange: $('pagerange'),
      pageRangeError: $('pagerange-error'),
    };
    this._wire();
    this._syncFormatOptions();
    this.refresh();
  }

  _wire() {
    const e = this.el;

    e.format.addEventListener('change', () => {
      this.userTouchedFormat = true;
      this.refresh();
    });

    // 解析度自由輸入：不自動改掉使用者打的數字，只驗證
    e.dpiValue.addEventListener('input', () => {
      const res = validate(e.dpiValue.value, this.unit);
      if (res.ok) this.dpi = res.dpi;
      this._showDpiValidity(res);
      this._updateChips();
      this.refresh({ skipDpiWrite: true });
    });

    // 切換單位：數值自動換算並顯示換算後的結果。
    // 內部的 this.dpi 一律保留完整精度，只有「顯示」四捨五入到小數點後 1 位。
    // 若欄位內容還是上一次換算顯示出來的值（使用者沒有自己改過），就直接沿用
    // 內部精度重新顯示，否則 500 → 196.9 → 切回會變成 500.1。
    e.dpiUnit.addEventListener('change', () => {
      const next = e.dpiUnit.value;
      const shown = e.dpiValue.value.trim();
      const untouched = shown === this._displayFor(this.unit);
      const typed = validate(shown, this.unit);
      if (!untouched && typed.ok) this.dpi = typed.dpi;
      this.unit = next;
      if (untouched || typed.ok) {
        e.dpiValue.value = this._displayFor(next);
        this._showDpiValidity({ ok: true, dpi: this.dpi });
      } else {
        this._showDpiValidity(validate(shown, next));
      }
      this._updateChips();
      this.refresh({ skipDpiWrite: true });
    });

    document.querySelectorAll('.chip[data-dpi]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const dpi = Number(chip.dataset.dpi);
        this.dpi = dpi;
        this.el.dpiValue.value = this._displayFor(this.unit);
        this._showDpiValidity({ ok: true, dpi });
        this._updateChips();
        this.refresh({ skipDpiWrite: true });
      });
    });

    e.quality.addEventListener('input', () => {
      e.qualityOut.textContent = e.quality.value;
      this.onChange(this.value());
    });

    document.querySelectorAll('input[name="bg"]').forEach((r) => {
      r.addEventListener('change', () => {
        e.bgCustom.disabled = document.querySelector('input[name="bg"]:checked').value !== 'custom';
        this.onChange(this.value());
      });
    });
    e.bgCustom.addEventListener('input', () => this.onChange(this.value()));

    e.maxEdgeOn.addEventListener('change', () => {
      e.maxEdge.disabled = !e.maxEdgeOn.checked;
      this.refresh({ skipDpiWrite: true });
    });
    e.maxEdge.addEventListener('input', () => this.refresh({ skipDpiWrite: true }));

    [e.pdfPageSize, e.pdfOrientation, e.pdfFit, e.pdfAspect].forEach((c) =>
      c.addEventListener('change', () => this.refresh({ skipDpiWrite: true })));
    document.querySelectorAll('input[name="pdfmode"]').forEach((r) =>
      r.addEventListener('change', () => this.onChange(this.value())));

    e.pageRangeMode.addEventListener('change', () => {
      const custom = e.pageRangeMode.value === 'custom';
      e.pageRange.hidden = !custom;
      this._validatePageRange();
      this.onChange(this.value());
    });
    e.pageRange.addEventListener('input', () => {
      this._validatePageRange();
      this.onChange(this.value());
    });
  }

  _syncFormatOptions() {
    const opt = [...this.el.format.options].find((o) => o.value === Fmt.HEIC);
    if (!opt) return;
    if (!HEIC_ENCODE_ENABLED) {
      opt.disabled = true;
      opt.textContent = 'HEIF/HEIC（目前無法輸出）';
    }
  }

  /** 目前內部 dpi 在指定單位下應該顯示的字串 */
  _displayFor(unit) {
    return unit === Unit.PPCM ? displayRound(dpiToPpcm(this.dpi)) : displayRound(this.dpi);
  }

  _showDpiValidity(res) {
    const e = this.el;
    this.valid = res.ok;
    if (res.ok) {
      e.dpiValue.removeAttribute('aria-invalid');
      e.dpiError.hidden = true;
      e.dpiError.textContent = '';
    } else {
      e.dpiValue.setAttribute('aria-invalid', 'true');
      e.dpiError.textContent = res.message;
      e.dpiError.hidden = false;
    }
  }

  _updateChips() {
    document.querySelectorAll('.chip[data-dpi]').forEach((chip) => {
      chip.setAttribute('aria-pressed', String(this.valid && Number(chip.dataset.dpi) === Math.round(this.dpi * 1000) / 1000));
    });
  }

  _validatePageRange() {
    const e = this.el;
    if (e.pageRangeMode.value !== 'custom') {
      e.pageRangeError.hidden = true;
      e.pageRange.removeAttribute('aria-invalid');
      this.pageRangeValid = true;
      return;
    }
    const v = e.pageRange.value.trim();
    const ok = v !== '' && /^\s*\d+\s*(-\s*\d+\s*)?(,\s*\d+\s*(-\s*\d+\s*)?)*$/.test(v);
    this.pageRangeValid = ok;
    if (ok) {
      e.pageRangeError.hidden = true;
      e.pageRange.removeAttribute('aria-invalid');
    } else {
      e.pageRangeError.textContent = '頁面範圍格式不正確，請輸入像 1-3 或 1,3,5 這樣的格式';
      e.pageRangeError.hidden = false;
      e.pageRange.setAttribute('aria-invalid', 'true');
    }
  }

  /** 依「有哪些輸入格式」調整可見的控制項與預設輸出格式 */
  setInputFormats(formats, firstItem) {
    this.inputFormats = new Set(formats);
    this.firstItem = firstItem || null;
    this.el.fieldPageRange.hidden = !this.inputFormats.has(Fmt.PDF);
    this.refresh({ skipDpiWrite: true });
  }

  /** 讓 main.js 在使用者還沒動過格式選單前，依輸入給合理預設（需求 9.6.5） */
  suggestFormat(fmt) {
    if (this.userTouchedFormat) return;
    if (fmt === Fmt.HEIC && !HEIC_ENCODE_ENABLED) return;
    const opt = [...this.el.format.options].find((o) => o.value === fmt);
    if (opt && !opt.disabled) {
      this.el.format.value = fmt;
      this.refresh({ skipDpiWrite: true });
    }
  }

  setLimits(limits) { this.limits = limits; this.refresh({ skipDpiWrite: true }); }

  /** 目前的輸出情境：'none' / 'pdf2img' / 'img2img' / 'img2pdf' / 'mixed' */
  scenario() {
    const out = this.el.format.value;
    const ins = this.inputFormats || new Set();
    if (ins.size === 0) return 'none';
    const hasPdfIn = ins.has(Fmt.PDF);
    const hasImgIn = [...ins].some((f) => f !== Fmt.PDF);
    if (out === Fmt.PDF) return hasPdfIn && hasImgIn ? 'mixed' : 'img2pdf';
    if (hasPdfIn && hasImgIn) return 'mixed';
    if (hasPdfIn) return 'pdf2img';
    return 'img2img';
  }

  _updateVisibility() {
    const e = this.el;
    const out = e.format.value;
    // 不相關的控制項用隱藏，不是變灰（需求第 11 節）
    e.fieldQuality.hidden = !(out === Fmt.JPEG || out === Fmt.PDF);
    e.fieldBackground.hidden = out !== Fmt.JPEG;
    e.fieldPdf.hidden = out !== Fmt.PDF;
    e.fieldMaxEdge.hidden = false;

    if (out === Fmt.PDF) {
      e.fieldQuality.querySelector('label').firstChild.textContent = 'JPEG 品質（只影響需要重新編碼的來源）';
    } else {
      e.fieldQuality.querySelector('label').firstChild.textContent = 'JPEG 品質 ';
    }

    if (out === Fmt.HEIC) {
      e.formatNote.textContent = HEIC_ENCODE_ENABLED ? HEIC_LIMITATIONS : DISABLED_REASON;
      e.formatNote.hidden = false;
    } else if (out === Fmt.PNG) {
      e.formatNote.textContent = 'PNG 是無損格式，沒有品質參數。';
      e.formatNote.hidden = false;
    } else {
      e.formatNote.hidden = true;
    }
  }

  _updateHint() {
    const s = this.scenario();
    if (this.el.format.value === Fmt.HEIC) {
      this.el.dpiHint.textContent = 'HEIF/HEIC 輸出無法寫入解析度中繼資料，解析度設定對這個格式不會生效；'
        + '像素尺寸請用下方的「限制最長邊像素」。';
      return;
    }
    const map = {
      pdf2img: '解析度決定渲染倍率與輸出像素尺寸（scale = dpi ÷ 72），同時寫入輸出檔的解析度資訊。',
      img2img: '不會改變像素尺寸，只會寫入檔案的解析度資訊。要改像素尺寸請用下方的「限制最長邊像素」。',
      img2pdf: '解析度決定像素換算成 PDF 實體尺寸的比例（實體寬度 pt = 像素寬度 ÷ dpi × 72）。',
      mixed: '這一批混合了 PDF 與影像來源，解析度會依每個檔案的情境分別套用。',
      none: '解析度的作用會依「輸入格式 → 輸出格式」而不同，加入檔案後這裡會說明。',
    };
    this.el.dpiHint.textContent = map[s] || '';
  }

  _updateEstimate() {
    const e = this.el;
    const item = this.firstItem;
    const many = (this.itemCount || 0) > 1;
    const suffix = many ? '（以第一個檔案計算）' : '';

    if (!this.valid) { e.dpiEstimate.textContent = ''; return; }
    if (!item) { e.dpiEstimate.textContent = '加入檔案後會顯示預估輸出尺寸。'; return; }

    const out = e.format.value;

    if (out === Fmt.PDF) {
      if (e.pdfPageSize.value === 'auto') {
        if (!item.meta || !item.meta.width) { e.dpiEstimate.textContent = ''; return; }
        const pt = imagePhysicalSizePt({ width: item.meta.width, height: item.meta.height }, this.dpi);
        e.dpiEstimate.textContent =
          `輸出頁面約 ${(pt.width * PT_TO_MM).toFixed(1)} × ${(pt.height * PT_TO_MM).toFixed(1)} 公釐${suffix}`;
      } else {
        const p = PAGE_SIZES[e.pdfPageSize.value];
        let { width, height } = p;
        const landscape = e.pdfOrientation.value === 'landscape'
          || (e.pdfOrientation.value === 'auto' && item.meta && item.meta.width > item.meta.height);
        if (landscape) [width, height] = [height, width];
        e.dpiEstimate.textContent =
          `輸出頁面 ${p.label} ${landscape ? '橫式' : '直式'}（${(width * PT_TO_MM).toFixed(0)} × ${(height * PT_TO_MM).toFixed(0)} 公釐）`;
      }
      return;
    }

    if (item.format === Fmt.PDF) {
      if (!item.meta || !item.meta.firstPageSizePt) { e.dpiEstimate.textContent = ''; return; }
      const px = pdfPageOutputPixels(item.meta.firstPageSizePt, this.dpi);
      const over = this.limits && (px.width > this.limits.maxDimension || px.height > this.limits.maxDimension
        || px.width * px.height > this.limits.maxArea);
      e.dpiEstimate.textContent = `輸出約 ${formatPixels(px)}${suffix}${over ? '　⚠ 超出瀏覽器繪圖上限' : ''}`;
      return;
    }

    if (!item.meta || !item.meta.width) { e.dpiEstimate.textContent = ''; return; }
    const px = imageOutputPixels({ width: item.meta.width, height: item.meta.height },
      e.maxEdgeOn.checked ? Number(e.maxEdge.value) : null);
    if (out === Fmt.HEIC) {
      e.dpiEstimate.textContent = `輸出約 ${formatPixels(px)}${px.scaled ? '（已套用最長邊上限）' : ''}${suffix}`;
      return;
    }
    e.dpiEstimate.textContent = px.scaled
      ? `輸出約 ${formatPixels(px)}（已套用最長邊上限）${suffix}`
      : `輸出約 ${formatPixels(px)}（像素尺寸不變，只改寫解析度資訊）${suffix}`;
  }

  setItemCount(n) { this.itemCount = n; this.refresh({ skipDpiWrite: true }); }

  refresh(opts = {}) {
    if (!opts.skipDpiWrite) {
      const res = validate(this.el.dpiValue.value, this.unit);
      if (res.ok) this.dpi = res.dpi;
      this._showDpiValidity(res);
      this._updateChips();
    }
    this._updateVisibility();
    this._updateHint();
    this._updateEstimate();
    this.onChange(this.value());
  }

  /** 目前設定的快照 */
  value() {
    const e = this.el;
    const bgChoice = document.querySelector('input[name="bg"]:checked');
    const bg = bgChoice && bgChoice.value === 'custom' ? e.bgCustom.value : (bgChoice ? bgChoice.value : '#ffffff');
    const merge = (document.querySelector('input[name="pdfmode"]:checked') || {}).value === 'merge';
    return {
      format: e.format.value,
      dpi: this.dpi,
      unit: this.unit,
      unitLabel: UNIT_LABEL[this.unit],
      quality: Number(e.quality.value),
      background: bg,
      maxEdgeEnabled: e.maxEdgeOn.checked,
      maxEdge: Number(e.maxEdge.value) || null,
      pdf: {
        pageSize: e.pdfPageSize.value,
        orientation: e.pdfOrientation.value,
        fitToPage: e.pdfFit.checked,
        keepAspect: e.pdfAspect.checked,
        merge,
      },
      pageRange: e.pageRangeMode.value === 'custom' ? e.pageRange.value.trim() : 'all',
      valid: this.valid && this.pageRangeValid !== false,
      limits: this.limits,
    };
  }
}

export { DPI_MIN, DPI_MAX, FMT_LABEL };
