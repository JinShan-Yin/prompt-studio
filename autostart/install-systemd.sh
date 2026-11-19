#!/usr/bin/env bash
# ============================================================
# NewRock AI Workbench · systemd 自启一键安装脚本
# 适用：具备 systemd 的 Linux（Ubuntu / Debian / CentOS / Rocky 等）
# 用法：sudo bash autostart/install-systemd.sh
# 卸载：sudo bash autostart/install-systemd.sh uninstall
# ============================================================
set -euo pipefail

SERVICE_NAME="newrock"
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/newrock.service"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"
PORT="$(grep -E '^PORT=' "${PROJECT_DIR}/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' \r\n' || true)"
PORT="${PORT:-3100}"
NODE_BIN="$(command -v node || true)"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

# ---------- 卸载 ----------
if [[ "${1:-}" == "uninstall" ]]; then
  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "${UNIT_DST}"
  systemctl daemon-reload
  grn "已卸载 ${SERVICE_NAME} 自启服务（项目文件未删除）"
  exit 0
fi

# ---------- 前置检查 ----------
[[ "$(id -u)" -eq 0 ]] || { red "请用 sudo 运行"; exit 1; }

if ! systemctl is-system-running >/dev/null 2>&1 && [[ "$(systemctl is-system-running 2>/dev/null || true)" == "offline" ]]; then
  red "当前环境没有运行 systemd（常见于容器/云沙箱）。"
  ylw "请改用 supervisord 方案：autostart/newrock-supervisor.conf"
  ylw "或前台脚本：autostart/start-newrock.sh"
  exit 1
fi

[[ -x "${NODE_BIN}" ]] || { red "未找到 node，请先安装 Node.js (>=18)"; exit 1; }
[[ -f "${PROJECT_DIR}/server.js" ]] || { red "未找到 server.js，脚本需放在项目 autostart/ 目录内"; exit 1; }
if [[ ! -d "${PROJECT_DIR}/node_modules" ]]; then
  ylw "未检测到 node_modules，正在执行 npm install ..."
  ( cd "${PROJECT_DIR}" && npm install )
fi

ylw "项目目录：${PROJECT_DIR}"
ylw "node：${NODE_BIN}"
ylw "端口：${PORT}"

# ---------- 生成 unit（替换路径、node、端口） ----------
sed \
  -e "s#WorkingDirectory=/opt/newrock-ai-workbench#WorkingDirectory=${PROJECT_DIR}#" \
  -e "s#ExecStart=/usr/bin/node#ExecStart=${NODE_BIN}#" \
  -e "s#Environment=PORT=3100#Environment=PORT=${PORT}#" \
  "${UNIT_SRC}" > "${UNIT_DST}"

grn "已生成 ${UNIT_DST}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null
systemctl restart "${SERVICE_NAME}"

# ---------- 等待并健康检查 ----------
for _ in $(seq 1 20); do
  sleep 0.5
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:${PORT}/login.html"; then break; fi
done

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PORT}/login.html" 2>/dev/null)"
  [[ -z "${code}" ]] && code="000"
  if [[ "${code}" == "200" ]]; then
    grn "安装成功：http://127.0.0.1:${PORT}  （login.html 返回 200）"
  else
    ylw "服务已启动，但健康检查返回 ${code}，请查看日志：journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  fi
  echo
  echo "常用命令："
  echo "  查看状态  systemctl status ${SERVICE_NAME}"
  echo "  查看日志  journalctl -u ${SERVICE_NAME} -f"
  echo "  重启      systemctl restart ${SERVICE_NAME}"
  echo "  停止      systemctl stop ${SERVICE_NAME}"
  echo "  卸载自启  sudo bash $0 uninstall"
else
  red "服务启动失败，日志如下："
  journalctl -u "${SERVICE_NAME}" -n 40 --no-pager || true
  exit 1
fi
