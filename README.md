# dsh-memory

DSH 跨会话长期记忆插件。详见 [docs/DETAIL.md](docs/DETAIL.md)，版本历史见 [CHANGELOG.md](CHANGELOG.md)。
Cross-session long-term memory plugin for DeepSeek Harness. See [docs/DETAIL.md](docs/DETAIL.md); version history in [CHANGELOG.md](CHANGELOG.md).

## 安装 Install

在装有 DSH 的会话中让 Agent 执行 `plugin_manager install_bundle`（target 为本目录的绝对路径），或在 **Plugins > Add plugin** 里选择本目录。
Install via `plugin_manager install_bundle` with this directory's absolute path, or pick this directory in **Plugins > Add plugin**.

## 开发 Develop

- 无构建步骤：纯 ESM；刻意不 import 任何 `@deepseek-ai/*` 包（本地链接目录的 ESM 解析够不到 DSH 安装树）。工具为纯对象定义，服务经 `inject` 由 `ctx` 提供，配置默认值在 `index.js` 内收敛。
- `lib/` 为纯 Node 模块，可独立测试：`node --test tests/*.test.mjs`。
- 数据目录：`~/.dsh/.dsh-memory/`。
