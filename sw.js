/**
 * sw.js — 離線快取（需求第 13 節）。
 *
 * 安裝時預先快取 app shell 與所有 WASM／PDF.js 資產；執行期採 cache-first。
 * 這個 Service Worker 只處理同源 GET，永遠不會對外部網域發出請求。
 *
 * PRECACHE 清單與 CACHE_VERSION 由 tools/gen-precache.py 產生，不要手動改。
 */

const CACHE_VERSION = '0d68b0e8f41f';
const CACHE_NAME = `local-converter-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'src/main.js',
  'src/codecs/heic-decode.js',
  'src/codecs/heic-encode.js',
  'src/codecs/image-decode.js',
  'src/codecs/image-encode.js',
  'src/codecs/pdf-decode.js',
  'src/codecs/pdf-encode.js',
  'src/codecs/pdfjs-assets.js',
  'src/core/canvaslimits.js',
  'src/core/capabilities.js',
  'src/core/detect.js',
  'src/core/errors.js',
  'src/core/exif.js',
  'src/core/metadata.js',
  'src/core/paths.js',
  'src/core/pipeline.js',
  'src/core/resolution.js',
  'src/core/surface.js',
  'src/core/workerpool.js',
  'src/core/zip.js',
  'src/ui/dialog.js',
  'src/ui/dropzone.js',
  'src/ui/filelist.js',
  'src/ui/settings.js',
  'src/workers/convert.worker.js',
  'styles/main.css',
  'vendor/elheif/elheif-wasm.js',
  'vendor/elheif/index.js',
  'vendor/fflate/fflate.js',
  'vendor/libheif/libheif.mjs',
  'vendor/pdf-lib/pdf-lib.esm.min.js',
  'vendor/pdfjs/pdf.min.mjs',
  'public/pdfjs/cmaps.pack',
  'public/pdfjs/pdf.worker.min.mjs',
  'public/pdfjs/standard_fonts.pack',
  'public/pdfjs/iccs/CGATS001Compat-v2-micro.icc',
  'public/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
  'public/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
  'public/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
  'public/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  'public/pdfjs/wasm/jbig2.wasm',
  'public/pdfjs/wasm/jbig2_nowasm_fallback.js',
  'public/pdfjs/wasm/openjpeg.wasm',
  'public/pdfjs/wasm/openjpeg_nowasm_fallback.js',
  'public/pdfjs/wasm/qcms_bg.wasm',
  'public/pdfjs/wasm/quickjs-eval.js',
  'public/pdfjs/wasm/quickjs-eval.wasm',
  'public/wasm/libheif.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 逐一加入：任何一個 404 都不該讓整個安裝失敗
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
        else console.warn('[sw] 略過', url, res.status);
      } catch (e) {
        console.warn('[sw] 略過', url, e && e.message);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('local-converter-') && n !== CACHE_NAME)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 本站不會有跨來源請求

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // 只快取成功的同源回應
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (e) {
      // 離線且沒快取：導覽請求退回首頁，其餘回 503
      if (req.mode === 'navigate') {
        const shell = await cache.match('./') || await cache.match('index.html');
        if (shell) return shell;
      }
      return new Response('離線中且此資源不在快取內', { status: 503, statusText: 'Offline' });
    }
  })());
});
