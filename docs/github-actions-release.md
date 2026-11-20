# 自动打包与发布（GitHub Actions）

本教程说明如何用 GitHub Actions 自动把 Reina 桌面端打包成各平台安装包，并发布到
GitHub Release。工作流定义在 [`.github/workflows/release.yml`](../.github/workflows/release.yml)。

---

## 1. 它做了什么

每当你推送一个 `v*` 格式的 tag（如 `v0.1.0`），GitHub 会在三台云端机器上**并行**打包：

| Runner | 架构 | 产物 |
|---|---|---|
| `windows-latest` | x64 | NSIS 安装包 + portable 免安装版 `.exe` |
| `macos-14`（Apple Silicon） | arm64 | `.dmg` + `.zip` |

打完后，安装包自动挂到名为该 tag 的 GitHub Release 上。

> **只打 Apple Silicon（arm64），不打 Intel（x64）。** 如需恢复 Intel，在
> `.github/workflows/release.yml` 的 matrix 里加回一项 `macos-13` + `--x64`
> （node-pty 是原生模块不能跨架构编译，Intel 必须用 Intel runner 单独打）。

每个 job 的内部流程：

```
npm ci            # 按 package-lock.json 装依赖
npm run build:desktop   # 编译 TypeScript、打包渲染层
rebuild-native    # 按 Electron ABI 重建 node-pty（关键，见下方说明）
electron-builder  # 生成安装包
上传 → 挂到 Release
```

> **关于 `rebuild-native`**：`package.json` 里设了 `"npmRebuild": false`，所以
> electron-builder **不会**自动重建原生模块。CI 必须显式跑
> `electron-rebuild -f -w node-pty`，否则打出来的 node-pty 是 Node ABI 版本，
> 装好的应用一启动就崩。这一步已经写进工作流。

---

## 2. 一次性准备（只做一次）

工作流文件必须先存在于 GitHub 的默认分支（`main`）上，GitHub 才认得它。

```powershell
git add .github/workflows/release.yml
git commit -m "ci: add GitHub Actions release workflow"
git push
```

> 推送含 `.github/workflows/` 的提交，需要 GitHub token 带 `workflow` 权限。
> 用 `gh auth status` 可查看当前 token 的 scope。

无需配置任何额外密钥：工作流用 GitHub 自带的 `GITHUB_TOKEN`，并已通过
`permissions: contents: write` 授予创建 Release 的权限。

---

## 3. 发布一个版本

### 方式 A：打 tag（推荐）

```powershell
# 1) 改 package.json 里的 version（建议与 tag 一致，例如 0.1.0），提交
# 2) 打 tag 并推送
git tag v0.1.0
git push origin v0.1.0
```

推送 tag 的瞬间触发构建。约 10–20 分钟后，仓库的 Releases 页面会出现 `v0.1.0`，
下面挂着 Windows / macOS 安装包。

### 方式 B：用 gh CLI

```powershell
# 创建 tag + Release，并触发打包；安装包会自动挂到这个 Release 上
gh release create v0.1.0 --generate-notes
```

`--generate-notes` 会根据 commit 自动生成发布说明。也可以加 `--title "标题"` 自定义。

### 方式 C：一键发版（本地）

```powershell
npm run release 0.1.4
```

这条命令在你本机依次完成：改 `package.json` 版本 → 提交并推送 → 打 `v0.1.4` tag 并推送
（触发云端构建）→ 等构建跑完。脚本见 [`scripts/release.mjs`](../scripts/release.mjs)。

- 有守卫：工作区不干净、tag 已存在、版本号没变都会直接拒绝，不会误操作。
- 代价：这条命令要在你电脑上跑、并等十来分钟构建完成（中途别关终端）。

---

## 4. 只想验证流程、不发正式版

手动触发一次（不会产生 Release，产物作为临时 artifact 上传，保留 90 天）：

```powershell
gh workflow run release.yml
```

或在网页：仓库 → **Actions** → 左侧选 **Release** → 右上 **Run workflow**。

> 区别在于工作流里的判断 `if: startsWith(github.ref, 'refs/tags/')`——只有 **tag 触发**
> 的运行才发布 Release；手动运行只上传临时 artifact。

---

## 5. 查看运行状态、下载产物

```powershell
gh run list --limit 5     # 最近几次运行及结果
gh run watch              # 实时盯最近一次运行
gh run view <run-id> --log        # 查看完整日志
gh run download <run-id>          # 下载该次运行的 artifact 到本地
```

正式 Release 的安装包则直接在仓库 **Releases** 页面下载，或：

```powershell
gh release download v0.1.0
```

---

## 6. 注意事项

- **macOS 未公证（ad-hoc 签名）**：CI 没有 Apple 开发者证书，app 只能做 ad-hoc
  签名（`build.mac.identity: null`）且未公证。在 Apple Silicon 上，下载的包带
  `com.apple.quarantine` 隔离属性，双击会直接报 **「应用程序 "Reina" 无法打开。-47」**
  （往往连「仍要打开」按钮都不出现）。绕过办法是下载解压后先去掉隔离属性再打开：

  ```bash
  xattr -dr com.apple.quarantine /path/to/Reina.app
  # 例如拖到「应用程序」后：
  xattr -dr com.apple.quarantine /Applications/Reina.app
  ```

  要彻底免去这一步（下载即用），需要 Apple 开发者账号（付费）做 Developer ID 签名 +
  公证，后续在工作流中加 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 等密钥并开启 `hardenedRuntime` 实现。
- **Windows 未签名**：SmartScreen 可能提示「未知发布者」，点「仍要运行」即可。代码签名
  同样可后续接入。
- **构建时长**：首次较慢（要下载 Electron、编译原生模块），通常单平台 5–15 分钟。
- **版本号**：tag（`v0.1.0`）与 `package.json` 的 `version`（`0.1.0`）最好保持一致，
  因为安装包文件名用的是 `package.json` 的 version（见 `build.artifactName`）。

---

## 7. 常见问题排查

| 现象 | 可能原因 / 处理 |
|---|---|
| 推送被拒，提示 workflow scope | token 缺 `workflow` 权限，重新 `gh auth login` 并勾选 workflow |
| 自动更新下载 404 / 装不上 | `latest.yml` 里的文件名必须与上传到 Release 的 asset 名一致。artifactName 不能带 `windows/`、`macos/` 这种子目录——名字里出现 `/` 会让 electron-builder 在 feed 里改用另一个文件名，与实际 asset 对不上 |
| `rebuild-native` 报找不到 node-pty | npm workspace 提升导致 node-pty 在根 `node_modules`；把日志贴出来，可能需要给 electron-rebuild 加 `--module-dir` |
| macOS 包启动即崩 | node-pty ABI 不匹配——确认 `rebuild-native` 那一步成功执行 |
| Release 没出现 | 确认是 **tag** 触发（`git push origin v0.1.0`），不是普通 push 或手动 run |
| 找不到 `*.exe` / `*.dmg` 上传失败 | electron-builder 打包失败，看 **Package** 那一步的日志 |

---

## 8. 触发逻辑一句话总结

> **先 push 工作流文件（一次性）→ 以后 `git push origin v版本号`（或 `gh release create v版本号`）就自动打包并发布。**
