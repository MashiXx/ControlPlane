# Mô tả commit: `docs(spec): agentless controller design`

**Commit:** `6d49388`
**Ngày:** 2026-04-20
**Branch:** `claude/create-commit-description-iTa91`
**File thêm mới:** `docs/superpowers/specs/2026-04-20-agentless-controller-design.md` (+235 dòng)

## Tóm tắt

Commit này thêm một bản thiết kế spec cho việc chuyển ControlPlane sang mô hình **agentless** — bỏ hoàn toàn tiến trình `agent/` và để `controller` điều khiển mọi server mục tiêu qua SSH. Đây là quá trình chuyển đổi một chiều, không có lớp tương thích ngược.

## Các quyết định cốt lõi

- **Agentless cho mọi action**: build / deploy / start / stop / restart / healthcheck / state polling đều đi qua SSH từ controller.
- **Build strategy gói gọn**: chỉ còn `controller`; `target` và `builder` bị loại bỏ.
- **State tracking**: thay reverse WebSocket + heartbeat bằng một vòng lặp SSH poll mặc định 30 giây trong controller.
- **Auth**: chỉ dựa vào `~/.ssh/config` của user chạy controller — không còn token agent, không secret SSH trong DB.
- **Logs**: stream trực tiếp cho action dài (deploy, build); buffer cho action ngắn (start/stop/healthcheck/poll).

## Tác động đến schema

Migration `db/migrations/004_agentless.sql` dự kiến sẽ:

- Drop: `servers.auth_token_hash`, `servers.agent_version`, `servers.artifact_transfer`, `applications.builder_server_id`.
- Thu nhỏ enum `applications.build_strategy` → chỉ còn `'controller'`.

## Thành phần xoá / thêm / sửa

- **Xoá**: toàn bộ workspace `agent/`, `controller/src/ws/hub.js`, `artifactTokens.js`, nhánh `http` của `artifactTransfer`, các schema `WsHello/WsExecute/...`, env `AGENT_*` / `ARTIFACT_SIGNING_SECRET`.
- **Thêm**: `controller/src/ssh/sshClient.js`, `controller/src/exec/remoteExec.js`, `controller/src/pollers/stateScheduler.js`.
- **Sửa**: `jobWorker.js`, `orchestrator.js`, `controller/src/index.js`, form server/application trong SPA, `package.json`, `.env.example`.

## Giữ nguyên

- Orchestrator là single chokepoint; mọi action vẫn đi qua `submitAction` → queue → worker → audit log.
- In-process queue, bốn queue đặt tên, idempotency window, chính sách retry `TransientError` vs `PermanentError`.

## Trạng thái

Spec đã **Approved, ready for implementation plan** — bước tiếp theo là viết plan triển khai + migration 004, chưa có code thay đổi trong commit này.
