# 双仓维护手册（私有开发仓 ↔ 公开发行仓）

> 2026-07-03 建立；2026-07-15 起公开仓改为**纯发行仓**（不再同步源码），
> `scripts/sync-public.mjs` 及其白名单已删除。本文档只存在于私有仓。

## 仓库模型

| 仓库 | 角色 | 内容 |
|---|---|---|
| `7-e1even/reina`（origin，私有） | 开发主仓 | 完整历史、内部文档（docs/）、TODO、发布流水线、全部脚本 |
| `Reina-Agent/Reina`（public，公开） | 发行仓 | main = README-only 孤儿提交 + Releases 下载页 / 更新 feed |
| `7-e1even/Reina-release` | **已删除** | 旧版更新 feed；v0.0.12 及以前的老安装包已静默断更（已知取舍） |

**红线：私有 main 永远不能直接推到公开仓。** 私有历史的旧提交里含有不可公开的内容
（第三方商业组件的移植痕迹、对非公开源码的引用、本机路径）。公开仓 main 只有
README-only 的孤儿提交，旧 release tag 已重指过去；除发版流水线外不应有任何推送。

## 日常开发

无感。在私有仓正常提交即可，源码不对外。

## 发版

流程与历史一致：改版本号 → 打 `v*` tag → push tag。CI（`.github/workflows/release.yml`）自动：

1. 双平台打包（win nsis+portable / mac arm64），rebuild node-pty；
2. 在**私有仓**建 Release 存档（GITHUB_TOKEN）；
3. 用 `MIRROR_TOKEN` 把安装包 + `latest.yml` + blockmap 跨仓发到 **Reina-Agent/Reina**
   ——这是新装用户的下载页和自动更新 feed（`package.json build.publish` 指向它）。

注意事项：

- **Release notes 必写**（新增/优化/修复三段，见既往版本格式）。
- **`MIRROR_TOKEN`** 是 7-e1even 的 PAT，需对 `Reina-Agent/Reina` 有 `contents:write`；
  过期或换号后在私有仓 Secrets 里更新。
- v0.0.12 及以前装出去的老版本 feed 指向 Reina-release，该仓删除后它们**静默断更**，
  只能手动到新仓下载（已知取舍）。

## 灾难恢复

公开仓被误删过一次（2026-07-03），完整重建流程验证有效：

1. `gh repo create Reina-Agent/Reina --public --description "..."`；
2. 重建 main：公开仓 main 是 README-only 孤儿提交（2026-07-15 起），在私有仓本地
   重做一个同形态的孤儿提交推 `public/main` 即可（无需任何源码历史）；
3. 重挂 release：`gh release create v<ver> -R Reina-Agent/Reina --target main
   --title ... --notes-file ... --latest <六个资产>`（资产可从私有仓 Release 存档重新下载）；
4. 验证：`https://github.com/Reina-Agent/Reina/releases/latest/download/latest.yml` 返回 200。

GitHub 误删仓库 90 天内也可在 org Settings → Deleted repositories 网页恢复
（恢复会连 Releases 一起回来，比重建省事——但同名新仓已建则无法恢复）。

## 定期清理（本仓）

- `release/`、`.tmp/` 下的镜像暂存与截图、`.logs/` 旧日志可随时删（可再生）；
  `.tmp/cdp-*.cjs` 调试脚本保留。
- 长期分支及时合并或删除；`git remote prune origin` 清悬空引用。
