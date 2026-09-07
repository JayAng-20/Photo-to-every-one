# 本機檔案格式轉換（PDF / PNG / JPEG / HEIF-HEIC）

純前端、零上傳的靜態網站。使用者在瀏覽器開啟後，可以把 **PDF、PNG、JPEG/JPG、HEIF/HEIC**
四種格式在本機互相轉換，檔案全程不離開裝置。首次載入完成後，中斷網路仍可完成轉檔。

- 沒有後端、沒有資料庫、沒有帳號、沒有任何分析或追蹤程式碼
- 不使用 CDN：所有函式庫與 `.wasm` 都與本站一起部署
- 轉檔過程不會發出任何對外請求（已用 DevTools 網路層實測，見下方驗收紀錄）

---

## 1. 啟動方式

> **`file://` 直接開啟不會運作。** module worker 與 WebAssembly 的 `fetch()` 會被瀏覽器擋下，
> 必須透過 HTTP(S) 提供。

### macOS / Linux（zsh 或 bash）

```bash
python3 -m http.server 8080
```

### Windows（PowerShell）

```powershell
python -m http.server 8080
```

### 開發時建議用附帶的伺服器

`python3 -m http.server` 不送 `Cache-Control`，瀏覽器會把 ES module 與 Worker 檔案快取住，
改了程式看不到效果。專案內附一支等價但補上 `no-store` 的伺服器：

```bash
python3 tools/serve.py 8080
```

啟動後開啟 <http://127.0.0.1:8080/>。

### 部署

把整個目錄原樣上傳到任何靜態主機即可（GitHub Pages、Netlify、Cloudflare Pages、
Nginx、Apache…）。沒有建置步驟，不需要 Node.js。唯一需要的伺服器設定是正確的 MIME：
`.mjs` → `text/javascript`、`.wasm` → `application/wasm`。

---

## 2. 使用流程

1. **加入檔案**：拖放到虛線區域，或按「選擇檔案…」。格式是**依檔案內容判定**的
   （magic bytes + ISO BMFF 的 `ftyp` brand），副檔名被改過也沒關係，
   清單上會標註實際格式。
2. **看清單**：每一列顯示縮圖、檔名、大小、原始格式、影像尺寸或 PDF 頁數。
3. **設定輸出**：格式下拉選單 + 可自由輸入的解析度欄位 + 單位切換
   （像素/英寸 ↔ 像素/公分），下方即時顯示預估輸出尺寸。
4. **開始轉換**：每個檔案有獨立進度與狀態；轉換期間介面仍可捲動、可取消。
5. **下載**：單檔可直接下載，多檔可一次打包成 ZIP。

### 解析度在三種情境下的意義

| 情境 | 解析度的作用 |
|---|---|
| PDF → 影像 | 決定渲染倍率與輸出像素尺寸（`scale = dpi ÷ 72`），並寫入輸出檔的解析度中繼資料 |
| 影像 → 影像 | **只改寫輸出檔的解析度中繼資料，不改變像素尺寸**；要改像素尺寸請用「限制最長邊像素」 |
| 影像 → PDF | 決定像素換算成 PDF 實體尺寸的比例（`實體寬度(pt) = 像素寬度 ÷ dpi × 72`） |

UI 會依目前的輸入／輸出組合，用一行小字說明目前套用的是哪一種。

---

## 3. 架構

沒有建置工具（本機沒有 Node/npm），直接用 `<script type="module">` 與原生 ES modules，
函式庫檔案手動放在 `vendor/`。

**PDF.js 資產打包**：PDF.js 的 169 個 cmap 與 16 個標準字型資產各自打包成一個
`.pack` 檔（前置 JSON 索引 + 二進位酬載），透過 PDF.js 6.x 的公開擴充點
`getDocument({ BinaryDataFactory })` 在執行期取出。打包檔只在第一次真的需要時才
`fetch()`，抓到後留在記憶體重複使用。`src/core/paths.js` 的
`USE_PACKED_PDFJS_ASSETS` 可以切回逐檔載入。

**統一中間層**：所有解碼器一律輸出 `{ width, height, data: Uint8ClampedArray /* RGBA8888 */ }`，
所有編碼器一律接受同一種型別。新增一種格式只要寫一個 decoder 加一個 encoder。
PDF 是唯一的多頁特例，「單張 vs 多張」的展開與收攏統一在 `src/core/pipeline.js` 處理。
跨 Worker 傳遞時 buffer 一律用 Transferable，不複製。

```
index.html                 進入點與整個 UI 骨架
sw.js                      Service Worker（安裝時預先快取，執行期 cache-first）
styles/main.css            樣式（深淺色跟隨系統、375px 起可用、系統字型堆疊）
src/
  main.js                  進入點、狀態管理、批次調度、下載與 ZIP
  ui/
    dropzone.js            拖放與檔案選擇、單檔／單批大小限制
    filelist.js            檔案清單、進度、狀態、object URL 生命週期
    settings.js            輸出設定面板（格式、解析度、品質、PDF 版面）
    dialog.js              確認對話框（超出 canvas 上限時使用）
  core/
    detect.js              格式偵測（magic bytes + ftyp brand）與結構完整性檢查
    resolution.js          解析度數值、單位換算、上限鉗制、輸出尺寸預估
    metadata.js            PNG pHYs / JPEG JFIF APP0 密度欄位改寫
    exif.js                EXIF Orientation 解析、HEIF irot/imir/ispe、RGBA 方向修正
    pipeline.js            統一轉換流程調度、支援矩陣、輸出檔名規則
    workerpool.js          Worker 池、任務佇列、取消、看門狗
    zip.js                 ZIP 串流打包（fflate，STORE 不壓縮）
    errors.js              錯誤碼與使用者可讀中文訊息對照
    capabilities.js        啟動時的能力偵測
    canvaslimits.js        執行期探測 canvas 最大寬高與最大面積
    surface.js             OffscreenCanvas / DOM canvas 的統一封裝
    paths.js               所有靜態資產位置（一律相對解析）
  codecs/
    pdf-decode.js          PDF.js 渲染成 RGBA、頁面範圍解析
    pdf-encode.js          影像 → PDF（pdf-lib）
    image-decode.js        PNG/JPEG 解碼
    image-encode.js        PNG/JPEG 編碼 + 解析度中繼資料改寫
    heic-decode.js         HEIC 解碼（原生優先、libheif WASM fallback）
    heic-encode.js         HEIC 編碼（Phase 2，elheif）
    pdfjs-assets.js        從打包檔供應 PDF.js 的 cmaps 與 standard_fonts
  workers/
    convert.worker.js      解碼／編碼工作執行緒
vendor/                    第三方函式庫（手動放置，見 LICENSES.md）
public/
  wasm/libheif.wasm        libheif 的 WebAssembly 二進位
  pdfjs/
    pdf.worker.min.mjs     PDF.js 的解析 worker
    cmaps.pack             169 個 .bcmap 打包成的單一檔案（部署用）
    standard_fonts.pack    16 個標準字型資產打包成的單一檔案（部署用）
    cmaps/                 原始 169 個 .bcmap（打包來源與比對基準，不部署）
    standard_fonts/        原始 16 個檔案；其中 4 個 LiberationSans TTF 仍要部署
    wasm/ iccs/            JBIG2 / OpenJPEG / QCMS 與 CMYK ICC（維持逐檔）
test-assets/               固定測試集（由 tools/make-test-assets.py 產生）
tools/                     開發與驗收用腳本（不屬於網站本身）
```

`tools/` 底下的東西**不是網站的一部分**，部署時可以不上傳：

| 檔案 | 用途 |
|---|---|
| `serve.py` | 開發用本機伺服器（`--allow-save` 才會開啟驗收用的存檔端點） |
| `make-test-assets.py` | 產生 `test-assets/` 的固定測試集（只用 python3 / sips / cupsfilter） |
| `inspect-dpi.py` | 檢查輸出檔的 PNG pHYs / JPEG JFIF 密度欄位（本機沒有 ImageMagick 時的替代品） |
| `gen-precache.py` | 重新產生 `sw.js` 的預先快取清單與版本號（`--unpacked` 產生逐檔模式的清單） |
| `pack-pdfjs-assets.py` | 把 `cmaps/` 與 `standard_fonts/` 打包成 `.pack`，並自我驗證位元組一致 |
| `make-deploy.py` | 把「確切要上傳的檔案」複製到 `dist/`，並交叉檢查沒有漏檔 |
| `verify-pack.html` | 打包資產的 169/169、16/16 比對與打包／逐檔渲染 A/B 對照（只能在原始碼樹跑） |
| `selftest.html` | **自我測試頁**：在任何瀏覽器一鍵跑完九條核心路徑並檢查輸出 |
| `heic-encode-spike.html` | Phase 2 的獨立最小 spike |
| `browser-harness.js` | 驗收時在 console 驅動真實 UI 的輔助工具 |
| `pnglib.py` | 測試素材產生器共用的 PNG 讀寫工具 |

**改過 `src/`、`styles/`、`vendor/`、`public/` 之後**，記得重新產生快取清單，
否則離線時拿到的是舊版：

```bash
python3 tools/gen-precache.py
```

**升級 PDF.js 之後**，還要重新打包資產：

```bash
python3 tools/pack-pdfjs-assets.py   # 重新打包並驗證 169/169、16/16
python3 tools/gen-precache.py        # 更新快取清單
```

部署範圍請看 [DEPLOY.md](DEPLOY.md)。

---

## 4. 驗證輸出的解析度中繼資料

依 HTML 規範，canvas 產生的影像會被固定寫成 96 dpi，所以本專案在編碼後會**手動改寫**：
PNG 插入／改寫 `pHYs` 區塊、JPEG 改寫 `JFIF APP0` 的密度欄位。驗證方式：

```bash
python3 tools/inspect-dpi.py 輸出檔.png 輸出檔.jpg
```

它會同時印出原始位元組與 macOS `sips` 的讀值做交叉比對。若有安裝 ImageMagick，
也可以用：

```bash
identify -verbose 輸出檔.png | grep -i resolution
```

macOS 上還可以直接在 Finder 用「取得資訊」查看。

---

## 5. 自我測試與離線驗證

開啟 <http://127.0.0.1:8080/tools/selftest.html> 按「開始測試」，
它會在**你目前的瀏覽器**實際跑完九條核心路徑並逐項檢查輸出（尺寸、四角顏色、
解析度中繼資料、頁數、ftyp brand），最後列出 PASS / FAIL。

**離線測試步驟：**

1. 連線狀態下先開啟一次主頁，讓 Service Worker 安裝完成
   （`tools/selftest.html` 底部會顯示「已啟用」）。
2. DevTools → Network → 勾選 **Offline**（Safari：「開發」選單 →「進入離線模式」）。
3. 重新整理後再跑一次自我測試，全部通過就代表離線可用。

---

## 6. 已知限制

- **HEIF/HEIC 輸出**（Phase 2，使用 elheif 0.1.0）：
  - **沒有品質參數**可調（上游 API 就沒有），所以 UI 選 HEIC 時品質滑桿會隱藏。
  - **無法寫入解析度中繼資料**，解析度設定對這個格式不會生效（UI 有明確說明）。
  - 速度較慢，約 0.8 秒／百萬像素。
- **AVIF / WebP / TIFF / GIF**：偵測得出來並會給明確的「不支援」訊息，但不做轉換。
- **PDF → PDF**：標為「不需要轉換」。
- **加密 PDF**：偵測到就標記失敗，不嘗試破解。
- **HEIC 多影像**（Live Photo、連拍、深度圖）：只取主影像，並在狀態列註明張數。
- PDF 頁面渲染在主執行緒進行（PDF.js 自己有 worker 做解析），每頁之間會讓出事件迴圈；
  實測轉換 24 頁 PDF 期間事件迴圈延遲中位數 0 ms、最大 86 ms。
- canvas 尺寸上限是**執行期探測**出來的，探測上限保守設在 16384²；
  超過上限時會先跳確認提示並提供替代 dpi，**不會**在使用者不知情下自動降解析度。

---

## 7. 隱私

- 檔案只存在於分頁的記憶體中，**不會**寫入 localStorage、IndexedDB 或任何持久化儲存。
- 產生的 PDF 只寫入必要中繼資料，不含原始檔案路徑、使用者名稱或裝置識別資訊。
- 沒有任何外部網路請求：不用 CDN、不用 Google Fonts、不用分析工具、不用錯誤回報服務。
  字型只用系統字型堆疊。

第三方元件與授權見 [LICENSES.md](LICENSES.md)。
