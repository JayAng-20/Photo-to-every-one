/**
 * pdf-encode.js — 影像 → PDF（pdf-lib）。
 *
 * 需求 8.2：
 *  - 兩種模式：合成單一多頁 PDF、各自獨立 PDF（由 pipeline 決定怎麼分組）
 *  - 頁面尺寸 A4/A3/Letter/依原始圖片尺寸，含直式橫式與自動判定
 *  - 預設「縮放至頁面內並維持長寬比、置中、留白 0」
 *  - JPEG/PNG 直接嵌入原始位元組（embedJpg/embedPng），避免二次失真
 *  - 中繼資料只寫必要欄位，不寫檔案路徑、使用者名稱或裝置資訊
 */

import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { PAGE_SIZES, imagePhysicalSizePt } from '../core/resolution.js';
import { AppError, ErrorCode } from '../core/errors.js';

/**
 * @typedef {{kind:'jpeg'|'png', bytes:Uint8Array, width:number, height:number, name?:string}} PageSource
 */

function resolvePageSize(src, settings) {
  if (settings.pageSize === 'auto') {
    const phys = imagePhysicalSizePt({ width: src.width, height: src.height }, settings.dpi);
    return { width: Math.max(1, phys.width), height: Math.max(1, phys.height), auto: true };
  }
  const base = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.a4;
  let { width, height } = base;
  let landscape;
  if (settings.orientation === 'landscape') landscape = true;
  else if (settings.orientation === 'portrait') landscape = false;
  else landscape = src.width > src.height;   // auto：依圖片長寬比
  if (landscape) [width, height] = [height, width];
  return { width, height, auto: false };
}

function placement(src, page, settings) {
  const iw = src.width;
  const ih = src.height;

  if (page.auto) {
    return { x: 0, y: 0, width: page.width, height: page.height, cropped: false };
  }

  if (settings.fitToPage) {
    if (settings.keepAspect === false) {
      return { x: 0, y: 0, width: page.width, height: page.height, cropped: false };
    }
    const k = Math.min(page.width / iw, page.height / ih);
    const w = iw * k;
    const h = ih * k;
    return { x: (page.width - w) / 2, y: (page.height - h) / 2, width: w, height: h, cropped: false };
  }

  // 關閉自動縮放：依 dpi 換算成實體尺寸放置，超出頁面就會被裁掉
  const phys = imagePhysicalSizePt({ width: iw, height: ih }, settings.dpi);
  const cropped = phys.width > page.width + 0.5 || phys.height > page.height + 0.5;
  return {
    x: (page.width - phys.width) / 2,
    y: (page.height - phys.height) / 2,
    width: phys.width,
    height: phys.height,
    cropped,
  };
}

/**
 * @param {PageSource[]} sources
 * @param {{pageSize:string, orientation:string, fitToPage:boolean, keepAspect:boolean, dpi:number}} settings
 * @returns {Promise<{bytes:Uint8Array, warnings:string[]}>}
 */
export async function encodePdf(sources, settings) {
  if (!sources || sources.length === 0) throw new AppError(ErrorCode.ENCODE_FAILED, 'no pages');
  const warnings = [];
  let doc;
  try {
    doc = await PDFDocument.create();
  } catch (e) {
    throw new AppError(ErrorCode.ENCODE_FAILED, e);
  }

  // 只寫必要且不具識別性的中繼資料
  doc.setProducer('本機檔案格式轉換工具');
  doc.setCreator('本機檔案格式轉換工具');
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);

  for (const src of sources) {
    let embedded;
    try {
      embedded = src.kind === 'jpeg' ? await doc.embedJpg(src.bytes) : await doc.embedPng(src.bytes);
    } catch (e) {
      throw new AppError(ErrorCode.ENCODE_FAILED, e);
    }
    const dims = { width: embedded.width, height: embedded.height };
    const srcWithDims = { ...src, width: dims.width || src.width, height: dims.height || src.height };
    const page = resolvePageSize(srcWithDims, settings);
    const place = placement(srcWithDims, page, settings);
    if (place.cropped) {
      warnings.push(`「${src.name || '影像'}」在 ${settings.dpi} dpi 下的實體尺寸超出頁面，超出的部分已被裁切`);
    }
    const pdfPage = doc.addPage([page.width, page.height]);
    pdfPage.drawImage(embedded, {
      x: place.x,
      y: place.y,
      width: place.width,
      height: place.height,
    });
  }

  try {
    const bytes = await doc.save({ useObjectStreams: true });
    return { bytes, warnings };
  } catch (e) {
    throw new AppError(ErrorCode.ENCODE_FAILED, e);
  }
}
