# Accounting 安全登入後端

此資料夾提供 GitHub Pages 前端所需的 Firebase Authentication、Cloud Functions 與 Firestore 規則片段。

## 安全原則

- 管理者密碼不寫入 HTML、GitHub 或 Firestore。
- Nick 的 `admin` 權限由 Firebase Admin SDK 設定。
- 小雯和彩屏透過 Nick 產生的一次性啟用碼，自行設定首次密碼。
- 使用者管理與改密碼只能透過具 `admin` 權限的 Cloud Function。
- `firestore.accounting.rules.snippet` 必須合併到現有規則，不能直接覆蓋共用專案的其他規則。

## 部署前必要設定

1. 在 Firebase Authentication 啟用「電子郵件／密碼」登入。
2. 部署 `functions`。
3. 將 Accounting 規則片段合併進現有 Firestore 規則並測試。
4. 使用受信任的 Firebase 管理環境執行 `npm run seed-admin`，以環境變數提供 `FIREBASE_PROJECT_ID` 與 `ADMIN_PASSWORD`。
5. 確認 GitHub Pages 網址 `https://nicktsai88.github.io/Accounting/` 可正常載入登入服務。

請勿將管理者密碼、服務帳戶金鑰或 Firebase CLI 權杖提交到 GitHub。

