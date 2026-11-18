#!/usr/bin/env bash
set +x
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ $# -ne 1 ]]; then
  printf '用法  bash init.sh hyper.example.com\n' >&2
  exit 1
fi
if [[ -e .env || -L .env ]]; then
  printf '.env 已存在。日常更新可直接使用 docker compose up -d --build。\n' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  printf '请先安装 Docker。\n' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '请先安装 Docker Compose 插件。\n' >&2
  exit 1
fi
umask 077
tmpenv="$(mktemp ./.hyper-watch-env.XXXXXX)"
trap 'rm -f -- "$tmpenv"' EXIT
read -rsp '设置看板登录密码（至少 16 个字符） ' password
printf '\n' >&2
read -rsp '再次输入登录密码 ' repeat
printf '\n' >&2
if [[ -z "$password" || "$password" != "$repeat" ]]; then
  printf '两次输入的密码不同，请重新运行初始化。\n' >&2
  exit 1
fi
printf '%s' "$password" | docker run --rm -i \
  -v "$PWD/scripts/configure.mjs:/tmp/configure.mjs:ro" \
  node:24-bookworm-slim node /tmp/configure.mjs "$1" > "$tmpenv"
unset password repeat
ln -- "$tmpenv" .env
printf '配置已生成。运行 docker compose up -d --build 启动看板。\n'
