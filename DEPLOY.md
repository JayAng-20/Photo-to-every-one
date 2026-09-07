# 部署說明

這是一個**純靜態網站**，沒有建置步驟。把下列檔案原樣上傳到任何靜態主機即可
（GitHub Pages、Netlify、Cloudflare Pages、Nginx、Apache…）。

---

## 1. 一行產生部署範圍

在 `01-final/` 底下執行：

```bash
python3 tools/make-deploy.py
```

它會把**確切該上傳的檔案**複製到同層的 `../02-github-upload/`，並自我檢查：

- `sw.js` 預先快取清單裡的每一個檔案都在集合內（少一個，Service Worker 安裝就會整個失敗）
- 不該部署的東西（`test-assets/`、`test-output/`、原始的 169 個 `.bcmap`）沒有混進來

之後上傳 `02-github-upload/` 的內容即可。該資料夾已列入 `.gitignore`。

想先看清單不複製：`python3 tools/make-deploy.py --list`

---

## 2. 要上傳什麼（**69 個必要檔案 + 1 個選配 = 70 個**，約 9.30 MB）

| 目錄 | 檔案數 | 說明 |
|---|---:|---|
| 根目錄 | 6 | `index.html`、`sw.js`、`.nojekyll`、`README.md`、`LICENSES.md`、`DEPLOY.md` |
| `styles/` | 1 | `main.css` |
| `src/` | 25 | 全部自寫程式（含 worker 與 `codecs/pdfjs-assets.js`） |
| `vendor/` | 11 | 五個第三方函式庫 + 各自的 LICENSE |
| `public/wasm/` | 1 | `libheif.wasm` |
| `public/pdfjs/` | 25 | 見下表 |
| `tools/` | 1（選配） | `selftest.html` |

`public/pdfjs/` 的 25 個檔案：

| 項目 | 數量 | 為什麼要 |
|---|---:|---|
| `pdf.worker.min.mjs` | 1 | PDF.js 的解析 worker |
| **`cmaps.pack`** | 1 | **169 個 `.bcmap` 打包成的單一檔案** |
| **`standard_fonts.pack`** | 1 | **16 個標準字型資產打包成的單一檔案** |
| `standard_fonts/LiberationSans-{Regular,Bold,Italic,BoldItalic}.ttf` | 4 | **不能省。** PDF.js 的系統字型替代會組出 `url(${standardFontDataUrl}LiberationSans-*.ttf)` 的 `@font-face`，那是瀏覽器直接抓的，**不經過 BinaryDataFactory**。這台 Mac 因為有對應的 local 字型所以不會抓，但沒有那些字型的機器會抓；少了它們，未內嵌字型的 PDF 會少一層字型回退 |
| `standard_fonts/LICENSE_FOXIT`、`LICENSE_LIBERATION` | 2 | 授權文字 |
| `iccs/CGATS001Compat-v2-micro.icc` + `LICENSE` | 2 | CMYK ICC。**不能打包**：`pdf.worker` 是用內部的 `fetchSync()` 自己抓，不走工廠 |
| `wasm/`（7 個二進位／回退 JS + 6 個 LICENSE） | 13 | JBIG2 / OpenJPEG / QCMS / QuickJS。走工廠轉發，但沒有打包 |
| `cmaps/LICENSE` | 1 | 授權文字 |

---

## 3. **不要上傳**

| 路徑 | 原因 |
|---|---|
| `public/pdfjs/cmaps/*.bcmap`（169 檔） | 已被 `cmaps.pack` 取代。**目錄本身保留在版本庫**，作為打包的來源、比對基準與回退來源 |
| `public/pdfjs/standard_fonts/*.pfb`（10 檔） | 已被 `standard_fonts.pack` 取代（4 個 TTF 仍要上傳，見上表） |
| `test-assets/`（18 檔） | 測試素材 |
| `test-output/` | 驗收證據，產生物 |
| `tools/` 其餘（`*.py`、`browser-harness.js`、`heic-encode-spike.html`、`pdfjs-assets.sha256.txt`） | 開發與驗收用，網站執行期完全用不到 |
| `.git/`、`.DS_Store`、`dist/` | — |

### `tools/` 的建議

**第一次部署時保留 `tools/selftest.html`**，這樣可以直接在線上環境（真實網域、
真實 HTTPS、真實 Service Worker）跑一次驗證，確認打包資產在生產環境也正常。
它會讀取 `test-assets/`，所以線上驗證時要一併上傳 `test-assets/`，
或接受它報「素材抓不到」。

**`tools/verify-pack.html` 不要部署。** 它的比對需要原始的 `public/pdfjs/cmaps/` 與
`standard_fonts/` 目錄，而那兩個目錄本來就不上傳，所以它只能在原始碼樹裡跑
（`python3 tools/serve.py 8090`）。

**確認沒問題之後，第二次部署就可以把整個 `tools/` 與 `test-assets/` 都拿掉。**

---

## 4. 主機需要的設定

| 項目 | 值 |
|---|---|
| `.mjs` | `text/javascript` |
| `.wasm` | `application/wasm` |
| `.pack` | `application/octet-stream`（預設就是，不必特別設） |
| `.bcmap` | 打包後已不需要 |
| Service Worker | `sw.js` 必須在網站根目錄，且**不要**送 `Cache-Control: no-store`（部分瀏覽器會直接拒絕註冊） |

`.nojekyll` 是給 GitHub Pages 用的，讓它跳過 Jekyll 處理。

所有資產路徑都用 `import.meta.url` 相對解析，所以掛在 `https://user.github.io/repo/`
這種帶子路徑的位置也能正常運作，不需要改任何設定。

---

## 5. 上傳後的驗證步驟

1. **開啟首頁**，確認畫面正常、頁尾的環境資訊有出現（並行度、繪圖上限）。
2. **開啟 `tools/selftest.html`**（若有上傳），按「開始測試」。應得到 **13 項 PASS、0 項 FAIL**。
   （`tools/verify-pack.html` 的 169/169 比對請在**本機原始碼樹**跑，它需要不部署的原始目錄。）
3. **確認打包路徑真的生效**：Network 面板應該只看到 `cmaps.pack` 與 `standard_fonts.pack`
   各一次請求，且**完全沒有**指向 `public/pdfjs/cmaps/` 的請求。
4. **確認 Service Worker 已安裝**：`selftest.html` 底部會顯示「已啟用（離線可用）」。
   若顯示「尚未安裝」，先重新整理首頁一次。
5. **離線測試**：DevTools → Network → 勾選 Offline → 重新整理 → 再跑一次 `selftest.html`。
   全部通過代表離線可用。
6. **確認沒有 404**：DevTools → Network，整個流程不應該出現任何 404，
   特別注意不要有指向 `public/pdfjs/cmaps/` 的請求（有的話代表打包模式沒有生效）。
7. **確認沒有對外請求**：Network 面板裡所有請求的網域都應該是你自己的網域。

### 出事時的即時回退

在 console 執行：

```js
(await import('./src/core/paths.js')).setUsePackedPdfjsAssets(false)
```

之後新開啟的 PDF 就會改走逐檔載入。**前提是那兩個原始目錄有上傳。**
永久回退請把 `src/core/paths.js` 的 `USE_PACKED_PDFJS_ASSETS` 改成 `false`，
重跑 `python3 tools/gen-precache.py --unpacked`，並把 `public/pdfjs/cmaps/` 與
`public/pdfjs/standard_fonts/` 完整上傳。

---

## 6. 更新 PDF.js 版本時

```bash
# 1) 換掉 vendor/pdfjs/ 與 public/pdfjs/ 的檔案
# 2) 重新打包並驗證
python3 tools/pack-pdfjs-assets.py
# 3) 更新預先快取清單
python3 tools/gen-precache.py
# 4) 用 tools/verify-pack.html 確認 169/169、16/16 與渲染一致
# 5) 重新產生部署目錄
python3 tools/make-deploy.py
```

升版後請特別確認兩件事：`BinaryDataFactory` 這個 API 參數是否還在，以及
`generateFont` 產生的 `@font-face` 是否引用了新的字型檔（會影響第 2 節那 4 個 TTF 的清單）。
