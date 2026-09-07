/**
 * canvaslimits.js — 執行期探測瀏覽器的 canvas 最大寬高與最大面積。
 *
 * 需求第 4.3 節明確要求「不要寫死記憶中的數字」，所以這裡逐步嘗試建立 canvas
 * 直到失敗。為了不讓探測本身把記憶體吃爆，面積探測設一個保守的上限
 * （PROBE_AREA_CEILING），超過就以該值作為已知下界回報。
 */

const DIM_LADDER = [1024, 2048, 4096, 8192, 11180, 16384, 32767];
// 面積探測用正方形邊長；16384² ≈ 2.68 億像素（約 1 GB RGBA），再往上不試。
const AREA_LADDER = [1024, 2048, 4096, 8192, 11585, 16384];

let cached = null;
let inflight = null;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function release(c) {
  try { c.width = 1; c.height = 1; } catch { /* 忽略 */ }
}

/** 真的畫一個像素再讀回來，確認 canvas 不是「建立成功但實際沒配置」。 */
function canAllocate(w, h) {
  let c = null;
  try {
    c = makeCanvas(w, h);
    if (c.width !== w || c.height !== h) return false;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(w - 1, h - 1, 1, 1);
    const d = ctx.getImageData(w - 1, h - 1, 1, 1).data;
    return d[3] === 255 && d[0] === 255;
  } catch {
    return false;
  } finally {
    if (c) release(c);
  }
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

async function probeLadder(ladder, test) {
  let best = 0;
  for (const v of ladder) {
    await nextTick();               // 讓出主執行緒，避免探測時畫面卡住
    if (test(v)) best = v; else break;
  }
  return best;
}

/**
 * @returns {Promise<{maxDimension:number, maxArea:number, probed:boolean, ceiling:boolean}>}
 */
export function probeCanvasLimits() {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    let maxDimension = await probeLadder(DIM_LADDER, (v) => canAllocate(v, 1) && canAllocate(1, v));
    if (!maxDimension) maxDimension = 1024; // 極端保守的退路

    const areaLadder = AREA_LADDER.filter((v) => v <= maxDimension);
    let side = await probeLadder(areaLadder, (v) => canAllocate(v, v));
    if (!side) side = Math.min(1024, maxDimension);

    const maxArea = side * side;
    cached = {
      maxDimension,
      maxArea,
      probed: true,
      // 探測到階梯頂端 → 真正的上限可能更高，我們用保守值
      ceiling: side === AREA_LADDER[AREA_LADDER.length - 1] || maxDimension === DIM_LADDER[DIM_LADDER.length - 1],
    };
    inflight = null;
    return cached;
  })();
  return inflight;
}

/** 已探測到的結果；還沒探測完時回傳一個保守值，呼叫端應優先 await probeCanvasLimits()。 */
export function knownLimits() {
  return cached || { maxDimension: 4096, maxArea: 4096 * 4096, probed: false, ceiling: false };
}
