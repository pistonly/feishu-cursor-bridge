# Docker 开发联调容器落地

- status: active
- related_modules: `docker/Dockerfile.dev`, `docker/compose.yaml`, `docker/dev-entrypoint.sh`, `docker/.dockerignore`, `README.md`, `docs/feishu-commands.md`
- related_memory:
- supersedes:

## 背景

本轮目标不是做生产部署，而是给当前飞书桥接服务补一套**本机开发联调**用的 Docker 方案，方便频繁重启、看日志和验证飞书到官方 ACP 的链路，同时尽量避免在容器里重新配置 Cursor Agent 登录态。

## 关键结论

1. 当前仓库适合采用“**bridge 容器化 + 宿主机 Cursor/Agent 状态复用**”的方案，而不是在镜像里重新完成 `agent login`。
2. 本机 `agent` 可执行文件路径已确认是 `/home/liuyang/.local/bin/agent`，实际运行时文件位于 `/home/liuyang/.local/share/cursor-agent/versions/...`。
3. 对官方 ACP 而言，仅把仓库代码挂进容器还不够；还需要同时挂载宿主机的 `~/.cursor`、`~/.config/Cursor`、`~/.local/share/cursor-agent`、`~/.local/bin` 与 `~/.feishu-cursor-bridge`。
4. 为了避免 `.env` 里的工作区绝对路径失效，容器内工作目录与宿主机保持同一路径前缀：`/home/liuyang/Documents/...`。
5. 由于 `node_modules` 使用 Docker volume，首次初始化时会遇到 root-owned volume 权限问题；当前开发版 compose 通过 `user: "0:0"` 规避，优先保证联调可用性。
6. 当前机器安装的是 `docker-compose` v1，而不是 `docker compose` 子命令，因此文档与命令示例统一使用 `docker-compose -f docker/compose.yaml ...`。

## 影响范围

- 新增 `docker/` 目录，集中存放开发容器配置，避免根目录继续堆 Docker 文件。
- `docker/compose.yaml` 提供 `bridge-dev` 服务，默认运行 `npm run dev`，并挂载宿主机上的 Cursor/Agent 状态目录与工作区目录。
- `docker/dev-entrypoint.sh` 在容器启动时检查关键挂载，并在 `package-lock.json` 变化后自动执行 `npm install`。
- `README.md` 新增 Docker 开发联调说明与常用命令。
- `docs/feishu-commands.md` 与 `README.md` 一并对齐到当前 `/mode`、`/model`、`/status` 的 official ACP 语义。

## 关联版本

- top-level: `3a82004458b1c9ef1f89c5f849f5524cfea80060`
- working tree:
  - 上述 commit 已包含 `docker/` 目录与相关文档更新。
  - 当前工作区仍有未提交的 ACP mode/model 相关源码改动，以及本条 memory 文件自身。

## 当前状态

- 已完成：
  - Docker 开发镜像已成功构建。
  - `docker-compose -f docker/compose.yaml config` 校验通过。
  - 已实测容器内可访问 `agent`，且能看到挂载进来的 Cursor 配置目录。
  - `node_modules` 可在容器启动时自动安装，`patch-package` 也能正常执行。
- 未完成：
  - 该方案当前是**本机路径写死**的开发联调版，不适合直接搬到其他机器。
  - 尚未拆出生产/常驻运行版 compose。
  - 尚未把 `docker-compose` v1/v2 的差异进一步抽象成更通用的脚本入口。

## 后续建议

1. 若后续仍频繁使用本地容器联调，可补一个 `Makefile` 或 `scripts/docker-dev.sh`，把 `up / restart / logs / down` 简化掉。
2. 若需要跨机器复用，优先把 `docker/compose.yaml` 里的宿主机绝对路径改成环境变量或 `.env` 驱动，而不是继续硬编码 `/home/liuyang/...`。
3. 若将来要做生产部署，建议新开一套与当前开发版隔离的 compose / Dockerfile，不要直接在这版 root + host-state bind mount 的基础上硬推到服务器。
