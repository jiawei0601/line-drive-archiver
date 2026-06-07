# line-drive-archiver

LINE 群組圖片自動歸檔系統。機器人加入群組後，自動將成員上傳的照片下載並存入 Google Drive，並附上前後 3 分鐘的對話記錄作為說明文字。

---

## 系統架構

```
LINE 群組
  │  成員上傳圖片／傳送文字
  ▼
[Webhook 伺服器]  ─── 寫入 ───▶  PostgreSQL
                                    │
               每日 03:00（台北時間）│
                                    ▼
                             [Cron 歸檔工兵]
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
             下載圖片（串流）               擷取 ±3 分鐘對話
                    │                               │
                    └───────────┬───────────────────┘
                                ▼
                         Google Drive
                    YYYY-MM-DD / 暱稱 /
                      ├── {messageId}.jpg
                      └── {messageId}_context.txt
```

---

## 部署流程總覽

| 步驟 | 平台 | 預估時間 |
|------|------|---------|
| 1. 申請 LINE Bot | LINE Developers | 10 分鐘 |
| 2. 建立 Google 服務帳戶 | Google Cloud Console | 15 分鐘 |
| 3. 設定 Google Drive 共用 | Google Drive | 5 分鐘 |
| 4. 部署到 Railway | Railway.app | 20 分鐘 |
| 5. 連接 Webhook | LINE Developers | 5 分鐘 |

---

## 步驟一：申請 LINE Bot

### 1-1 建立 LINE Developers 帳號
1. 前往 [LINE Developers Console](https://developers.line.biz/console/)
2. 使用個人 LINE 帳號登入
3. 首次登入需同意開發者條款

### 1-2 建立 Provider
1. 點選左側「**Create a new provider**」
2. 填入 Provider 名稱（例如：`My Company`）
3. 點選「**Create**」

### 1-3 建立 Messaging API Channel
1. 在 Provider 頁面點選「**Create a new channel**」
2. 選擇「**Messaging API**」
3. 填寫以下欄位：

| 欄位 | 說明 |
|------|------|
| Channel type | Messaging API |
| Provider | 剛才建立的 Provider |
| Channel name | 機器人顯示名稱（例如：`Drive Archiver`） |
| Channel description | 簡短描述 |
| Category | 選擇適合的類別 |
| Subcategory | 選擇子類別 |

4. 同意使用條款，點選「**Create**」

### 1-4 取得金鑰

進入 Channel 後，記錄以下兩個金鑰：

**① Channel Secret**
- 路徑：`Basic settings` → `Channel secret`
- 點選「**Issue**」產生

**② Channel Access Token（長期）**
- 路徑：`Messaging API` → `Channel access token`
- 點選「**Issue**」產生
- 選擇 **long-lived**（長期有效）

> ⚠️ 這兩個金鑰等同密碼，請勿提交至版本控制或公開分享。

### 1-5 設定機器人加入群組的權限
路徑：`Messaging API` → `LINE Official Account features`

| 功能 | 設定值 |
|------|--------|
| Allow bot to join group chats | **Enabled** |
| Auto-reply messages | **Disabled**（避免機器人自動回覆） |
| Greeting messages | **Disabled** |

---

## 步驟二：建立 Google Cloud 服務帳戶

### 2-1 建立或選擇 GCP 專案
1. 前往 [Google Cloud Console](https://console.cloud.google.com)
2. 點選頂部「**選取專案**」→「**新增專案**」
3. 填入專案名稱（例如：`line-drive-archiver`）

### 2-2 啟用 Google Drive API
1. 左側選單 → 「**API 和服務**」→「**程式庫**」
2. 搜尋「**Google Drive API**」
3. 點選「**啟用**」

> 若未啟用此 API，所有 Drive 操作都會回傳 403 錯誤。

### 2-3 建立服務帳戶
1. 左側選單 → 「**IAM 與管理員**」→「**服務帳戶**」
2. 點選「**建立服務帳戶**」
3. 填寫：

| 欄位 | 說明 |
|------|------|
| 服務帳戶名稱 | 例如：`drive-archiver` |
| 服務帳戶 ID | 自動填入（不需修改） |
| 說明 | 例如：`LINE 機器人 Drive 歸檔用` |

4. 點選「**完成**」（不需指定 IAM 角色，權限由 Drive 共用控制）

### 2-4 下載 JSON 金鑰
1. 在服務帳戶清單找到剛建立的帳戶，點選帳戶名稱
2. 切換到「**金鑰**」標籤
3. 點選「**新增金鑰**」→「**建立新的金鑰**」
4. 格式選「**JSON**」→「**建立**」
5. 瀏覽器自動下載 `.json` 檔案，**妥善保存**

> ⚠️ 此 JSON 檔案包含私鑰，只能下載一次。遺失須重新建立。

### 2-5 記錄服務帳戶 Email
在服務帳戶詳細頁面找到「**電子郵件**」欄位，格式如：

```
drive-archiver@your-project-id.iam.gserviceaccount.com
```

稍後設定 Google Drive 共用時需要這個 Email。

---

## 步驟三：設定 Google Drive 共用

### 3-1 建立根資料夾
1. 前往 [Google Drive](https://drive.google.com)
2. 「**新增**」→「**資料夾**」，命名例如：`LINE 歸檔`

### 3-2 共用給服務帳戶
1. 對資料夾按右鍵 →「**共用**」
2. 在「**新增使用者或群組**」欄位貼上步驟 2-5 取得的服務帳戶 Email
3. 角色選擇「**編輯者**」
4. 取消勾選「傳送電子郵件通知」
5. 點選「**共用**」

> 為何必須做這步：服務帳戶上傳的檔案，預設只有服務帳戶自己看得到。共用資料夾給服務帳戶後，它在此資料夾下建立的所有子目錄與檔案都會繼承你的帳號權限，你才能在 Drive 介面看到歸檔結果。

### 3-3 取得資料夾 ID
在 Google Drive 網頁端打開剛建立的資料夾，複製網址列中的 ID：

```
https://drive.google.com/drive/folders/【這段就是資料夾 ID】
```

---

## 步驟四：部署到 Railway

### 4-1 建立 Railway 帳號
1. 前往 [Railway.app](https://railway.app)
2. 使用 GitHub 帳號登入（建議，方便連結 repo）

### 4-2 建立新專案
1. 點選「**New Project**」
2. 選擇「**Deploy from GitHub repo**」
3. 搜尋並選取 `line-drive-archiver`
4. Railway 自動偵測到 `railway.json` 並開始建構

### 4-3 新增 PostgreSQL 資料庫
1. 在專案頁面點選「**+ New**」→「**Database**」→「**PostgreSQL**」
2. Railway 自動建立資料庫並產生連線資訊

### 4-4 取得資料庫連線字串（Session Pooler）

> ⚠️ 重要：Railway 部分區域僅支援 IPv4，Supabase 等外部資料庫的直連網址可能解析為 IPv6 而無法連線。若使用 Railway 內建 PostgreSQL，直接複製即可。

1. 點選資料庫服務 →「**Variables**」
2. 複製 `DATABASE_URL` 的值

### 4-5 設定環境變數
在 Webhook 伺服器服務頁面，點選「**Variables**」→「**Raw Editor**」，貼入以下內容並替換各值：

```
DATABASE_URL=（步驟 4-4 複製的連線字串）
LINE_CHANNEL_SECRET=（步驟 1-4 的 Channel Secret）
LINE_CHANNEL_ACCESS_TOKEN=（步驟 1-4 的 Channel Access Token）
GOOGLE_SERVICE_ACCOUNT_CREDENTIALS=（步驟 2-4 下載的 JSON 檔案內容，整段貼入，單行格式）
GOOGLE_DRIVE_ROOT_FOLDER_ID=（步驟 3-3 的資料夾 ID）
RAILWAY_SHM_SIZE_BYTES=524288000
PHOTO_BACKUP_CRON=0 19 * * *
```

**將 JSON 金鑰轉為單行格式的方法：**

```bash
# Mac / Linux
cat your-service-account.json | tr -d '\n'

# Windows PowerShell
(Get-Content your-service-account.json -Raw) -replace "`r`n|`n", "" | Set-Clipboard
```

### 4-6 確認部署健康狀態
1. 切換到「**Deployments**」標籤
2. 等待部署完成（約 2–3 分鐘）
3. 點選「**View logs**」確認出現：

```
[server] Listening on port 3000
[migrate] Schema applied successfully.
```

4. 取得公開網域：「**Settings**」→「**Networking**」→「**Generate Domain**」
   - 格式如：`https://line-drive-archiver-production.up.railway.app`

### 4-7 設定 Cron 歸檔工兵（第二個服務）

Cron 工兵需要獨立部署為短生命週期服務：

1. 在專案頁面點選「**+ New**」→「**GitHub Repo**」→ 選取同一個 repo
2. 進入新服務的「**Settings**」→「**Deploy**」：
   - `Start Command` 改為：`node dist/cron.js`
3. 切換到「**Settings**」→「**Cron Schedule**」：
   - 填入：`0 19 * * *`（UTC 時間，等同台北時間凌晨 3 點）
4. 在「**Variables**」複製 Webhook 伺服器的所有環境變數貼入（兩個服務需要相同的環境變數）

---

## 步驟五：設定 LINE Webhook

### 5-1 填入 Webhook URL
1. 回到 [LINE Developers Console](https://developers.line.biz/console/)
2. 進入 Channel →「**Messaging API**」→「**Webhook settings**」
3. 點選「**Edit**」，填入：

```
https://（步驟 4-6 的 Railway 網域）/webhook
```

例如：
```
https://line-drive-archiver-production.up.railway.app/webhook
```

4. 點選「**Update**」
5. 點選「**Verify**」，應看到「**Success**」

### 5-2 啟用 Webhook
確認「**Use webhook**」開關已開啟（預設可能是關閉）。

---

## 步驟六：測試整體流程

### 6-1 將機器人加入群組
1. 開啟 LINE Developers Console →「**Messaging API**」→「**Bot information**」
2. 掃描 QR Code 加入機器人好友
3. 建立或進入一個 LINE 群組，邀請這個機器人

### 6-2 功能驗證

**即時寫入測試（Webhook 伺服器）：**
1. 在群組傳一段文字 → 資料庫 `chat_history` 應新增一筆
2. 在群組傳一張圖片 → 資料庫 `image_tasks` 應新增一筆（status: `pending`）

**歸檔測試（Cron 工兵）：**
1. 手動觸發 Cron 服務（Railway 頁面 →「**Trigger**」）
2. 約 30 秒後，前往 Google Drive 確認：

```
LINE 歸檔/
└── 2026-06-07/
    └── 上傳者暱稱/
        ├── {messageId}.jpg
        └── {messageId}_context.txt
```

3. 開啟 `_context.txt`，應包含圖片上傳前後 3 分鐘的文字對話記錄

---

## 環境變數說明

| 變數名稱 | 取得位置 | 說明 |
|---------|---------|------|
| `DATABASE_URL` | Railway PostgreSQL → Variables | 必須使用 Session Pooler 格式（IPv4 相容） |
| `LINE_CHANNEL_SECRET` | LINE Developers → Basic settings | 用於驗證 Webhook 簽章，防止偽造請求 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers → Messaging API | 用於呼叫 LINE API（下載圖片、查詢暱稱） |
| `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` | GCP Console → 服務帳戶金鑰 JSON | 整個 JSON 內容，轉為單行字串 |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | Google Drive 網址列 | 已共用給服務帳戶的根資料夾 ID |
| `RAILWAY_SHM_SIZE_BYTES` | 固定值 `524288000` | 解除容器共享記憶體限制（PostgreSQL 高併發必要） |
| `PHOTO_BACKUP_CRON` | 固定值 `0 19 * * *` | 對照用，實際排程在 Railway Cron Schedule 設定 |

---

## 常見問題

### Q：群組成員沒有加機器人好友，照片可以下載嗎？

**可以。** 機器人加入群組後，可接收群組內所有成員的訊息，不論對方有沒有加好友。取得暱稱時系統會自動使用群組成員 API（`/group/{groupId}/member/{userId}`），不需要好友關係。

---

### Q：Webhook 驗證失敗，出現 401？

確認以下事項：
- `LINE_CHANNEL_SECRET` 是否填寫正確（注意 Channel Secret 和 Access Token 不要搞混）
- Webhook URL 是否為 HTTPS（LINE 不接受 HTTP）
- Railway 服務是否已正常啟動（Health check 有回應）

---

### Q：Google Drive 看不到上傳的檔案？

確認步驟三的共用設定：
- 服務帳戶的 Email 必須加入為根資料夾的**編輯者**
- `GOOGLE_DRIVE_ROOT_FOLDER_ID` 必須是**根資料夾**的 ID，不能是子資料夾

---

### Q：Cron 任務被 skip，沒有執行？

Cron 工兵執行完畢必須主動結束進程，否則 Railway 偵測到上一次實例尚未終止，會跳過下一次排程。

確認 Railway Cron 服務的 logs 最後出現：

```
[cron] Connection pool closed. Exiting.
```

若沒有，代表程序卡住，請檢查資料庫連線是否正常。

---

### Q：Cron Schedule 填 UTC 還是台北時間？

Railway 排程器使用 **UTC 時間**。台北時間（UTC+8）換算：

| 台北時間 | UTC | Cron 表達式 |
|---------|-----|------------|
| 每天凌晨 3:00 | 每天 19:00 | `0 19 * * *` |
| 每天凌晨 2:00 | 每天 18:00 | `0 18 * * *` |
| 每天中午 12:00 | 每天 04:00 | `0 4 * * *` |

---

## 本地端開發

```bash
# 安裝依賴
npm install

# 編譯 TypeScript
npm run build

# 執行測試
npm test

# 本地啟動（需先設好 .env）
cp .env.example .env
# 編輯 .env 填入真實金鑰
npm start
```

---

## 安全注意事項

- `.env` 已加入 `.gitignore`，請勿手動提交
- `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` JSON 內含私鑰，只存放在 Railway Variables
- LINE Channel Secret 用於 HMAC-SHA256 簽章驗證，外洩會讓任何人可以偽造 Webhook 請求
- 若金鑰外洩，立即在對應平台重新產生（LINE：Reissue；GCP：刪除舊金鑰並建立新金鑰）
