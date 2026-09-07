# ⚠ 這個資料夾是產生物，不要編輯

`02-github-upload/` 由 `01-final/tools/make-deploy.py` 產生，
**每次重跑都會整個刪掉重建，任何手動修改都會被覆蓋。**

要改內容請改 `01-final/` 底下的原始碼（`src/`、`styles/`、`index.html`、`public/` …），
然後在 `01-final/` 底下重跑：

```bash
python3 tools/make-deploy.py
```

若改動涉及會被 Service Worker 快取的檔案，請先重跑 `python3 tools/gen-precache.py`
更新 `sw.js` 的清單，再跑 `make-deploy.py`。

本資料夾的內容 = `sw.js` 預先快取清單 + 第三方授權文字 + 文件 + `tools/selftest.html`，
共 70 個檔案。詳細的部署範圍與上傳後驗證步驟見 `DEPLOY.md`，
在本機測試的方式見 `如何在本機測試.md`。

這個資料夾已列入 `.gitignore`，不納入版控。
