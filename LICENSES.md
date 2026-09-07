# 第三方元件與授權

所有函式庫都以 **未修改的形式** 從 npm registry 下載後放進 `vendor/` 與 `public/`，
沒有經過打包器改寫。每個套件原本的 LICENSE 檔案都一併保留在它的目錄下。

| 套件 | 版本 | 授權 | 放置位置 | 用途 |
|---|---|---|---|---|
| [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) | 6.3.289 | Apache-2.0 | `vendor/pdfjs/pdf.min.mjs`、`public/pdfjs/` | PDF 解析與逐頁渲染 |
| [pdf-lib](https://www.npmjs.com/package/pdf-lib) | 1.17.1 | MIT | `vendor/pdf-lib/` | 影像 → PDF 生成 |
| [fflate](https://www.npmjs.com/package/fflate) | 0.8.3 | MIT | `vendor/fflate/` | ZIP 串流打包（STORE） |
| [libheif-js](https://www.npmjs.com/package/libheif-js) | 1.23.2 | **LGPL-3.0** | `vendor/libheif/libheif.mjs`、`public/wasm/libheif.wasm` | HEIF/HEIC 解碼 |
| [elheif](https://www.npmjs.com/package/elheif) | 0.1.0 | MIT | `vendor/elheif/` | HEIF/HEIC 編碼（Phase 2） |

`jspdf` 4.2.1（MIT）有下載評估過，但最終沒有採用（改用 pdf-lib，理由見下），
因此不在本專案內。

## 需要注意的授權事項

### libheif-js 是 LGPL-3.0

需求第 17 節要求「不得使用 x265 或任何 GPL 授權會傳染到本專案的元件」。
`libheif-js` 是 **LGPL-3.0**（不是 GPL）：

- 本專案 **沒有修改** libheif 的原始碼，也沒有把它靜態連結進自己的程式碼。
  `vendor/libheif/libheif.mjs` 是上游 `libheif-wasm/libheif.js` 的原檔，
  唯一的改動是在檔尾補一行 `export default libheif;`（把 UMD 包成 ES module，
  因為本專案採無建置版本、必須用原生 `import`）。WebAssembly 二進位
  `public/wasm/libheif.wasm` 是原檔，一個位元組都沒動。
- 使用者可以自行以相同版本的上游檔案替換這兩個檔案，本專案仍能正常運作，
  符合 LGPL 對「可替換元件」的要求。
- 上游的完整授權條文保留在 `vendor/libheif/LICENSE`。

如果你的專案政策連 LGPL 都不能接受，把 `src/codecs/heic-decode.js` 的 WASM 路徑拿掉
即可（Safari 仍可透過 `createImageBitmap()` 的原生路徑解 HEIC，其他瀏覽器則會回報
「HEIF/HEIC 解碼元件載入失敗」）。

### elheif 使用 kvazaar，不是 x265

`elheif` 由 libheif + libde265 + **kvazaar** 編成 WebAssembly，包裝層是 MIT。
kvazaar 是 **BSD-3-Clause**，符合需求第 17 節「若要 HEVC 編碼只能用 BSD 授權的 kvazaar」。
本專案沒有使用 x265。上游授權檔保留在 `vendor/elheif/LICENSE`。

### PDF.js 隨附的第三方元件

`public/pdfjs/wasm/` 內含 PDF.js 自帶的 JBIG2、OpenJPEG、QCMS 等解碼器的
WebAssembly 二進位，各自的授權檔（`LICENSE_JBIG2`、`LICENSE_OPENJPEG`、
`LICENSE_QCMS` 等）都一併複製過來了。

### PDF.js 資產的打包不影響授權

為了降低部署檔案數，`public/pdfjs/cmaps/` 的 169 個 `.bcmap` 與
`public/pdfjs/standard_fonts/` 的 16 個檔案各自被**原樣串接**成一個 `.pack` 檔
（`tools/pack-pdfjs-assets.py`）。打包是位元組層級的忠實搬運，沒有轉碼、沒有壓縮、
沒有篩選，內容與 pdfjs-dist 6.3.289 隨附的檔案完全一致（169/169 與 16/16 已用
SHA-256 逐一驗證）。原始目錄仍完整保留在版本庫內。

字型授權文字（`LICENSE_FOXIT`、`LICENSE_LIBERATION`）除了包在
`standard_fonts.pack` 內，也另外以純文字檔一併部署。4 個 `LiberationSans-*.ttf`
因為會被 PDF.js 產生的 `@font-face` 直接引用，同樣以原始檔案形式部署。

## 為什麼選 pdf-lib 而不是 jsPDF

`pdf-lib` 的 `embedJpg()` / `embedPng()` 可以直接嵌入原始位元組，
JPEG → PDF 不必重新編碼、不掉品質。本專案只有在真的需要改變像素時
（來源是 HEIC、或使用者開了「限制最長邊像素」）才走 RGBA 中間層重新編碼。
實測沒有遇到阻礙，所以維持第 4.2 節的建議選型。

## 沒有使用的東西

沒有 CDN、沒有 Google Fonts、沒有分析或錯誤回報服務、沒有 SharedArrayBuffer，
也不需要 COOP/COEP 跨來源隔離標頭。字型只用系統字型堆疊。
