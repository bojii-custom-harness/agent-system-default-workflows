---
name: plugin-discovery
description: 依可觀察證據搜尋、取得授權、匯入並登錄外部 OpenCode Plugin。
---

# Plugin Discovery

這是產品管理、版本為 2.0.0 的 System Skill，只能由 Find Plugin Default Workflow 使用。

## Search 與授權

1. 將需求轉成包含「OpenCode plugin」及使用者指定名稱或功能的有界 search，先使用 `websearch` 搜尋 OpenCode Plugin 官方文件、作者 repository 或其他可查核來源；使用 `webfetch` 讀取候選的作者文件及安裝說明。使用者提供的確切名稱或網址優先，不可只憑名稱相似認定是同一 Plugin。
2. 僅將有作者文件或 repository 明確證明支援 OpenCode 的候選呈現給使用者；每個候選須列出名稱、簡短 purpose、作者來源連結、OpenCode 相容性證據與作者指定的安裝來源。最多列出 8 個；無法取得證據時說明未驗證或查詢失敗，不把一般套件當成已確認的 OpenCode Plugin。
3. 以作者文件指定的安裝方式決定來源。npm registry 只用來核對作者文件指定的 npm 套件及版本，不以一般 npm 搜尋結果或相似名稱取代 Plugin discovery；Git 來源需查明完整 pinned commit。來源不明時先向使用者確認，不得猜測。
4. 使用者只提出能力需求時，先呈現候選並等待使用者明確選定；在選定前不可呼叫 `find-plugin-import-v2`。
5. 使用者明確要求安裝指定 Plugin 或 repository 時，該要求本身就是安裝授權，不必重複要求選候選；但仍須先以 `webfetch` 讀取作者安裝文件，解析 OpenCode 版本與安裝來源，再呼叫 `find-plugin-import-v2`。repository 網址不等於可執行的 Plugin 發行來源。若 README 同時介紹獨立應用程式與 OpenCode Plugin，繼續讀取連結的 installation、migration 或 release 文件，不可只看首頁便判定不相容。若作者要求在 OpenCode 的 `plugin` 設定填入套件名稱，核對該官方套件的確切版本後，以 npm source 交由 OpenCode 原生 installer 載入，不匯入缺少 dist 的開發分支。這是取得已確認 OpenCode Plugin 的發行包，不是搜尋一般 npm 套件。
6. 一般任務中自行發現 Plugin 時，先向使用者詢問安裝同意，再進行匯入。
7. search 沒有相容結果、source 無效或匯入失敗時，回報有界原因；不得捏造 Plugin、能力、成功或 readiness。

### Discovery tool format

- `webfetch` 的 `format` 只接受 `text`、`markdown` 或 `html`；呼叫時使用其中一種，不要傳 `json`。
- 讀取 npm registry 等 JSON endpoint 時，使用 `format: text`，再解析工具回傳的 response body。若 tool 回報 format/schema error，依錯誤列出的合法值修正並重試同一查詢；重試成功前將該來源標為未完成，不可宣稱候選搜尋完整。

### Import source schema

- npm source 形狀固定為 `{"type":"npm","package":"<name>@<exact-version>"}`；版本必須併入 `package` 字串，不要另傳 `version` 欄位。例如 `{"type":"npm","package":"opencode-localise-timestamps@0.1.1"}`。
- Git source 使用 `{"type":"git","repository":"<repository-url>","revision":"<pinned-commit>"}`；local source 使用 `{"type":"local","path":"<project-local-path>"}`。每種 source 只送 import Tool schema 接受的欄位。
- 例如 oh-my-openagent 同時有 Native 獨立程式與 Ultimate OpenCode Plugin；須依作者 `docs/guide/installation.md` 的 OpenCode 安裝章節解析發行包，不可將 Native 版介紹當成整個 repository 不支援 OpenCode 的證據。版本以查詢時作者發行資訊為準，不寫死。

## Import、registration 與 readiness

1. 取得明確授權後，以使用者核准的 source 呼叫 `find-plugin-import-v2`。只把該工具回傳的 exact `source`、`resolved.contentHash`、`resolved.version`／`revision` 與 `targets` 當作 provenance/runtime evidence；不可自行補造或改寫。
成功的 `find-plugin-import-v2` response 會提供 exact `pluginName`；將這個 pluginName 傳給後續工具，不可自行改名或猜測。
2. 只有 import 成功後才能呼叫 `find-plugin-register`。對同一個成功 import，必須分開呼叫兩次：一次 `registration` 物件的 `scope: "project"`、`project`、`target: "main"`，一次 `target: "workflow-test"`；每次都提交 exact provenance、recognition、backgroundBehaviors 與該 target 實際觀察到的 contributions。每個 request 只有單一 `target` 欄位；不可用一個 `targets` wrapper 包兩個 target。
`recognition` 必須是 `{"status":"complete"}` 或 `{"status":"partial","unavailable":["<bounded reason>"]}`；不要用 `name`、`type`、`purpose` 代替 recognition 狀態。每個 `backgroundBehaviors` 項目必須是 `{"kind":"hook","name":"<observed hook>","description":"<observed behavior>"}`；不可只傳 hook 字串陣列。沒有 callable resources 時 `contributions` 使用空陣列。
Provenance 必須來自 import response：npm 的 `source` 是 exact `source.package`，`revision` 是 `resolved.contentHash`；Git 的 `source` 是 `source.repository`、`revision` 是 pinned `source.revision`；local 的 `source` 是 `source.path`、`revision` 是 `resolved.contentHash`。兩次 registration 都使用 import response 的 exact `pluginName`。
此步驟的操作順序是：after successful import 才呼叫 `find-plugin-register`，並遵守上述每個 target 一次的 payload 契約。
3. registration status `unverified` 只表示 registration 已保存，不表示 readiness。登錄後必須讀取 public Catalog，使用其 `pluginContributions` 與 `targetStatuses` 回報 `main` 和 `workflow-test`。
4. 只照實回報 `verified`、`unverified`、`stale`、`runtime-unavailable` 或 `missing`。registration 或 Catalog read 失敗時回報有界錯誤，不可宣稱已登錄或 ready，也不可從 import result 推論 readiness。
5. import 成功後，使用同一成功 response 的 `pluginName`，並依安裝說明與 runtime evidence 辨識 parameter requirements。Only when the observed parameter requirements are a non-empty array call `find-plugin-parameters`; pass `requirements` as a JSON array string，例如 `[{"name":"API_KEY","description":"...","required":true,"sensitive":true}]`，不可用 `{ "parameters": [...] }` wrapper。If there are no parameter requirements (empty array), skip the Tool call，避免不必要的 runtime reload。只提交 name、description、required、sensitive 與空值 metadata；不可在 chat 詢問、收集或傳送任何 parameter value，值由 UI 填寫。
6. `find-plugin-parameters` 的 `main` 是 shared 共用需求與預設值邊界；`workflow-test` 會繼承 shared 設定，使用者在 UI 填寫的 workflow-test override 必須維持 target-specific。不得臆造 hidden defaults、替 UI 填值或把敏感值回傳給 Agent。

## 以 evidence 為基礎的辨識

閱讀安裝說明，只使用可觀察的 package/runtime evidence。只有 evidence 支持其 kind 與 name 時，才將 contribution 記為 Agent、Skill、Tool 或 MCP。另行記錄 parameter requirements 與 background hooks；`hook` 不是 callable capability。MCP 維持一個 server，保留實際觀察到的 tool selection，不把每個 MCP tool 拆成獨立 server，也不發明不存在的能力。

未觀察的能力不得登錄為 verified；保留 partial recognition 與有界 unavailable reasons。不得將 secrets、credentials、tokens 或敏感 parameter values 放入 Agent output、chat 或 Skill output。不得執行不必要的程式、修改 source files，或恢復 source-writing fallback。完成條件是取得有界 import result，並由 Catalog response 回報兩個 target statuses 與僅包含已觀察 contributions 的結果。
