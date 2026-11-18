# Agent System Default Workflows

此公開來源 repo 維護 Agent System 核准的 11 個 Default Workflow、三個產品自管 System Skills、不可變版本 tags、Release assets 與累加式 catalog。Workflow 與 bundle 以精確 SemVer 發布；本 repo 不負責 Agent System runtime Plugin／guard，也不在 runtime 解析 latest。

## 來源與範圍

- 首批內容取自 Agent System 已提交 baseline `7f5c7a56bce02501547e2933bbefd7f4a745f0b9`。
- 11 個 Workflow 的 ID、UUID、graph、資源與內容維持來源原貌，只把核准的內容版本標記改為 `2.0.0`。
- 三個產品 System Skills 為 `plugin-discovery`、`workflow-assembly`、`resource-authoring`；Skill 內容版本與 bundle 版本均為 `2.0.0`。
- 初版所有產品從 `2.0.0` 起始；後續各 Workflow 與 System Skills bundle 依自身 SemVer 獨立演進，不要求彼此版本相同。
- `system-skills/manifest.json` 保留已支援的舊版安裝內容 hash，並精確新增 `1.0.8`／`1.0.9` upgrade mappings。
- 不包含 `find-skills`、`skill-creator` 的 runtime Skill 原始檔，也不包含 Agent System runtime Plugin／guard 程式碼。Workflow JSON 內既有的 Resource references 仍依 baseline 保留。

## 需求

- Node.js 24 或更新版本
- Git

無第三方 npm dependencies。安裝 CLI 時可使用 `npm install`；固定安裝使用 `npm ci`。

## 檢查

```powershell
npm ci
npm run check
npm run validate
npm test
```

`npm test` 使用 Node 內建 test runner，涵蓋來源基線、Workflow／manifest validators、SemVer、Windows PowerShell 子程序、本機 bare Git tag 往返、發布冪等性、衝突拒絕及 catalog 併發／重試。

## CLI

```powershell
node .\bin\default-workflows.mjs catalog --output .\catalog.json
node .\bin\default-workflows.mjs download workflow-generator 2.0.0 --catalog .\catalog.json --output .\workflow-generator.json
node .\bin\default-workflows.mjs list
node .\bin\default-workflows.mjs history workflow-generator
node .\bin\default-workflows.mjs history system-skills
node .\bin\default-workflows.mjs validate
node .\bin\default-workflows.mjs publish workflow-generator 2.0.0 --remote origin
node .\bin\default-workflows.mjs publish system-skills 2.0.0 --remote origin
```

`catalog` 只從本 CLI 固定的公開 catalog 來源更新版本目錄；`download` 依 catalog 中指定的 Workflow 或 System Skills 版本，下載並驗證精確 release metadata、大小、SHA-256 與內容身分，再寫入 `--output`。可用 `--metadata-output` 額外保存已驗證的 release metadata；省略 `--catalog` 時，`download` 會先由 CLI 取得遠端 catalog。兩個命令都不安裝或切換 Agent System 版本。

`list` 顯示目前 source 版本、catalog 可取得版本與本機 Git tags；`history` 只列指定產品的明確 tag／catalog 版本。CLI 不推送 branch。`publish` 僅建立並推送一個精確 tag，絕不 force-update；已存在且指向相同 source commit／bytes 的 tag 可冪等重試，來源或內容不同則拒絕。

Workflow tag 格式為 `<workflow-id>-<SemVer>`，bundle tag 格式為 `system-skills-<SemVer>`。正式 SemVer 是 `stable`，含 prerelease 的 SemVer 是 `dev`。CLI 推送 tag 後，GitHub Actions 會讀取所有已推送的有效 tags，驗證並補完不可變 Release assets，再以有界 compare-and-swap 重試更新 `catalog.json`。可在 Actions 對既有 tag 執行 `Publish Releases` workflow_dispatch 重試；流程會重新讀取既有 tag、Release 與 assets，不覆寫衝突內容。

## 發布契約

- 每個 Workflow Release 的主要 asset 為 `workflow-<id>-<version>.json`。
- System Skills bundle asset 為 `system-skills-<version>.json`，包含 manifest 及三份完整 UTF-8 `SKILL.md`。
- 每個 Release 另附 `release-metadata.json`，記錄 tag、source commit、channel、主要 asset URL、byte size 與 SHA-256。
- Catalog 僅保存精確 tag、kind／ID、SemVer/channel、source commit 與每個 Release asset 的公開 URL、大小、SHA-256；沒有 repo-wide latest。
- 相同 tag 的重跑會匿名讀回現有 asset 並比較完整 bytes／metadata；缺項可補齊，已存在但不符者 fail-closed。
- Catalog 更新採 Contents API SHA compare-and-swap，遇到並行更新會重新讀取 catalog／Release inventory 並有界重試，保留其他 entries。

## 來源檔案

- `workflows/`：11 個完整 Default Workflow JSON 與其受驗證 inventory manifest。
- `system-skills/`：三份產品 Skill 與 bundle manifest；不含第三方 runtime Skill 檔。
- `schemas/`：Workflow、System Skills manifest／bundle、source／baseline／inventory、Release metadata 與 catalog JSON Schema。
- `src/`：SemVer、source／schema validators、CLI、bundle／Release、GitHub API 與 catalog 同步實作。
- `.github/workflows/`：Node 24 CI 與 tag／Release／catalog pipeline。

## 安全界線

GitHub Actions 僅要求 `contents: write`，目標固定為本 repo；不接受 fork 上的發布。Release tags 不可覆寫，GitHub Releases 及 assets 不會刪除或替換。失敗時保留既有內容並回報錯誤，不會 fallback 至 latest 或其他 repo。
