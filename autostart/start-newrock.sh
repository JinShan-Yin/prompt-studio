#!/usr/bin/env bash
# ============================================================
# NewRock AI Workbench · 通用启动脚本（Linux / macOS / 无 systemd 环境）
#
# 用法：
#   bash autostart/start-newrock.sh            前台运行（Ctrl+C 停止）
#   bash autostart/start-newrock.sh bg         后台运行（写 logs/newrock.log）
#   bash autostart/start-newrock.sh status     查看运行状态
#   bash autostart/start-newrock.sh stop       停止后台进程
#   bash autostart/start-newrock.sh check      仅做健康检查
#
# 说明：脚本会读取项目 .env 的 PORT，未配置时用 3100。
# ============================================================
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"

LOG_DIR="${PROJECT_DIR}/logs"
PID_FILE="${LOG_DIR}/newrock.pid"
LOG_FILE="${LOG_DIR}/newrock.log"

PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' \r\n' || true)"
PORT="${PORT:-3100}"

grn() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }

port_in_use() { command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ":$1 " ; }

http_code() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PORT}/login.html" 2>/dev/null)"
  [[ -z "${code}" ]] && code="000"
  printf '%s' "${code}"
}

health() {
  echo "http://127.0.0.1:${PORT}/login.html -> $(http_code)"
}

wait_ready() {
  local i
  for i in $(seq 1 30); do
    [[ "$(http_code)" == "200" ]] && return 0
    sleep 0.5
  done
  return 1
}

running_pid() {
  if [[ -f "${PID_FILE}" ]]; then
    local p; p="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${p}" ]] && kill -0 "${p}" 2>/dev/null; then echo "${p}"; return 0; fi
  fi
  return 1
}

case "${1:-fg}" in
  status)
    if pid="$(running_pid)"; then grn "运行中，PID=${pid}"; health; else ylw "未通过本脚本后台运行"; health; fi
    ;;
  check)
    health
    ;;
  stop)
    if pid="$(running_pid)"; then
      kill -TERM "${pid}" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "${pid}" 2>/dev/null || break; sleep 0.3; done
      rm -f "${PID_FILE}"
      grn "已停止 PID=${pid}"
    else
      ylw "没有找到由本脚本启动的后台进程"
    fi
    ;;
  bg)
    if pid="$(running_pid)"; then red "已在运行 PID=${pid}，先执行 stop"; exit 1; fi
    if port_in_use "${PORT}"; then red "端口 ${PORT} 已被占用，请释放或改 .env 的 PORT"; exit 1; fi
    mkdir -p "${LOG_DIR}"
    nohup node server.js >> "${LOG_FILE}" 2>&1 &
    echo $! > "${PID_FILE}"
    if pid="$(running_pid)"; then
      if wait_ready; then
        grn "后台启动成功，PID=${pid}，日志：${LOG_FILE}"; health
      else
        red "进程已启动但健康检查未通过，日志：${LOG_FILE}"; tail -20 "${LOG_FILE}" 2>/dev/null; exit 1
      fi
    else
      red "启动失败，查看日志：${LOG_FILE}"; tail -20 "${LOG_FILE}" 2>/dev/null; exit 1
    fi
    ;;
  fg|*)
    if port_in_use "${PORT}"; then red "端口 ${PORT} 已被占用，请释放或改 .env 的 PORT"; exit 1; fi
    grn "前台启动，端口 ${PORT}，Ctrl+C 停止"
    exec node server.js
    ;;
esac
