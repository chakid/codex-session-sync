# codex-sessions

本地 `npm` 工具，用来管理 Codex sessions，核心目标是解决 `model_provider` 隔离导致的历史会话不可直接复用问题。

当前版本已经把前端收敛为一个更直接的迁移控制台：

- 前端基于 `Vite + Vue 3 + Element Plus`
- 页面聚焦会话迁移管理
- 后端和 CLI 仍然保留现有实现，后续功能可以继续逐步接回前端

## 当前前端能力

- 读取 `~/.codex/state_5.sqlite`
- 启动时自动检测当前 Codex 数据目录是否可用
- 如果默认目录不可用，支持在页面中手动切换 Codex 数据目录
- 列出 sessions
- 按 `model_provider` 和关键词筛选
- 支持会话选择、多选、当前筛选结果全选
- 查看 session 详情
- 支持单会话迁移
- 支持批量迁移
- 支持批量导出会话压缩包
- 支持导入导出的会话压缩包
- 导入前会自动执行现有快照备份
- 当前页面中的 `克隆` / `批量克隆` 仅为占位按钮，尚未接入前端逻辑

当前读取策略：

- 优先读取 `threads` 表
- 如果当前电脑上的 `state_5.sqlite` 还是空主库、而真正数据尚未 checkpoint 回主库，则会尝试退回到 `sessions/*.jsonl` 和 `session_index.jsonl` 读取
- 因此即便当前环境没有安装 `sqlite3`，只要 `.codex/sessions` 目录存在，页面仍然可以先显示 provider、会话列表和详情

当前前端实际执行的是 `retarget` 迁移流程。后端会先执行 `prepareBackup()` 检查，再继续真正的数据写入。

当前前端导入会话包时，会先复用项目现有的快照备份逻辑，生成目录：

- `~/.codex/backups/codex-sessions/snapshot-*`

快照中除数据库和 sessions 目录外，也会包含：

- `session_index.jsonl`
- `.codex-global-state.json`

## 迁移语义

当前迁移控制台围绕 `retarget` 语义工作，也就是把已有会话从一个 `model_provider` 迁移到另一个 `model_provider`，而不是创建新的会话副本。

单会话迁移的核心步骤：

1. 执行 `prepareBackup()` 检查
2. 改写原 `rollout_path` 对应 `jsonl` 中的 `model_provider`
3. 更新 SQLite `threads.model_provider`

批量迁移的核心步骤：

1. 对整批会话只执行一次 `prepareBackup()` 检查
2. 逐个改写每个会话对应 `rollout_path` 中 `jsonl` 的 `model_provider`
3. 统一提交 SQLite 中对应 `threads.model_provider` 的更新

约束说明：

- 迁移不会更新 `updated_at`
- 迁移不会伪造新的会话活跃时间
- 批量迁移会跳过已经属于目标 `provider` 的会话
- 当前前端的 `克隆` / `批量克隆` 仍然只是占位，不代表前端已接入克隆流程

## 技术栈

- 后端：Node.js + 原生 HTTP + `sql.js`
- 前端：Vite + Vue 3 + Element Plus
- 分发方式：CLI + 本地 dashboard

## 目录结构

```text
bin/                  CLI 入口
backend/              SQLite、文件操作、HTTP API、dashboard 启动逻辑
frontend/             Vue 3 管理界面
tests/                Node 测试
```

## 开发环境

- Node.js >= 20.19.0
- npm >= 10
- 建议安装 `sqlite3` CLI

安装依赖：

```bash
npm install
```

## 本地开发

启动开发模式：

```bash
npm run dev
```

它会同时启动：

- Vite 前端：`http://127.0.0.1:4173`
- 本地 API：`http://127.0.0.1:4588`

开发态下前端请求 `/api/*` 会自动代理到本地 API。

## 生产构建

构建 dashboard：

```bash
npm run build
```

这一步会生成前端静态资源到：

```text
dist/web
```

启动 dashboard：

```bash
npm run dashboard
```

默认地址：

```text
http://127.0.0.1:4588
```

## 首次使用与目录自检

页面启动时会自动检查当前使用的 Codex 数据目录。

默认目录是：

```text
~/.codex
```

如果遇到以下情况：

- 当前电脑没有安装 Codex
- Codex 数据目录不在默认位置
- `state_5.sqlite` 是空主库，但 `sessions` 目录里仍有会话文件

页面会提示当前状态，并允许你手动填写 Codex 数据目录。

注意这里填写的是：

- Codex 数据目录

不是：

- Codex 程序本体的安装目录

通常一个可用的 Codex 数据目录下会包含这些内容中的一种或多种：

```text
state_5.sqlite
state_5.sqlite-wal
sessions/
session_index.jsonl
```

如果你只有一个 `state_5.sqlite` 文件，而且它体积非常小，例如只有 4096 字节，那么它通常只是一个空主库；这种情况下还需要配套的：

- `state_5.sqlite-wal`

或者：

- `sessions/`

否则无法恢复会话列表。

## 打包 npm package

如果你的目标不是只在本地运行，而是生成一个可安装、可分发的 npm 包，还需要执行打包：

```bash
npm pack
```

这一步会基于当前项目的 `package.json`、`files`、`bin` 和构建产物生成一个 `.tgz` 包。

当前项目里：

- `npm run build`
  负责构建前端 dashboard 资源
- `npm pack`
  负责生成可安装的 npm package

如果后续要正式发布到 npm，再在这之后执行：

```bash
npm publish
```

## CLI 用法

当前前端聚焦迁移能力，但 CLI 仍然保留完整命令集。

常用命令：

```bash
node ./bin/codex-sessions.js dashboard
node ./bin/codex-sessions.js list --limit 20
node ./bin/codex-sessions.js clone --thread <thread-id> --to <provider>
node ./bin/codex-sessions.js retarget --thread <thread-id> --to <provider>
```

如果作为 npm package 使用：

```bash
codex-sessions dashboard
npx @kindyroo/codex-sessions dashboard
```

## 前端使用的 API

当前 Vue 前端只依赖这些接口：

- `GET /api/providers`
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/retarget`
- `POST /api/sessions/batch/retarget`
- `POST /api/sessions/export/archive`
- `POST /api/import/archive/batch`

后端中其他 API 仍然保留，但现在不在前端界面中展示。

## 校验

```bash
npm run check
npm test
npm run build
```
