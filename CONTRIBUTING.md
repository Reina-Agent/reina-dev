# 贡献指南 / Contributing to Reina

感谢你愿意为 Reina 出力！这份指南帮你快速上手。

## 开始之前

- **小改动**(修 typo、文档、明显的 bug)：直接提 PR。
- **较大改动 / 新功能**：请先开一个 Issue 讨论，避免白做工。
- 想找事做？看带 [`good first issue`](https://github.com/Reina-Agent/Reina/labels/good%20first%20issue) 标签的任务。

## 开发环境

```bash
git clone https://github.com/Reina-Agent/Reina.git
cd reina
npm install
npm run build:desktop
npm run desktop          # Windows 可用 ./start-desktop.cmd
```

要求 Node.js >= 22。架构与目录说明见 [`docs/file-navigation.md`](./docs/file-navigation.md)。

## 提交前自查

请在提交 PR 前本地跑通：

```bash
npm run check        # TypeScript 类型检查
npm test             # 单元测试
npm run lint         # ESLint
npm run format:check # Prettier 格式
```

## 提交规范

- 提交信息建议用 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:` / `fix:` / `docs:` / `chore:` 等。
- 一个 PR 只做一件事，保持 diff 聚焦、可审。
- 改动要能追溯到对应的需求或 Issue。

## DCO —— 贡献者来源认证

提交 PR 即表示你同意 [Developer Certificate of Origin](https://developercertificate.org/)：你确认这些代码由你原创、有权以本项目的许可证(AGPL-3.0)贡献出来。

请在每个 commit 用 `-s` 附上签名：

```bash
git commit -s -m "feat: 你的改动"
```

这会在提交信息末尾加上 `Signed-off-by: Your Name <you@example.com>`。

> 注意：你的贡献将以 **AGPL-3.0** 许可。项目作者保留以其他许可(含商业闭源)再分发整体作品的权利。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](./CODE_OF_CONDUCT.md)。

## 问题反馈

- Bug / 功能建议：开 [Issue](https://github.com/Reina-Agent/Reina/issues)。
- 安全漏洞：**不要**开公开 Issue，按 [SECURITY.md](./SECURITY.md) 私下反馈。
