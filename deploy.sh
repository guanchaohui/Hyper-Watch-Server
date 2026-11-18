#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ ! -f compose.yaml || ! -f .env ]]; then
  printf '请把脚本放在 Hyper-Watch-Server 项目目录。首次部署请按部署说明生成 .env。\n' >&2
  exit 2
fi

for program in docker curl flock; do
  if ! command -v "$program" >/dev/null 2>&1; then
    printf '本机缺少命令 %s。\n' "$program" >&2
    exit 2
  fi
done

exec 9>.deploy.lock
if ! flock -n 9; then
  printf '已有一次部署正在进行，请等它结束后重试。\n' >&2
  exit 3
fi

docker compose config --quiet
if ! docker compose up -d --build --wait --wait-timeout 180 hyper; then
  printf '构建、启动或容器健康检查失败。可用 docker compose logs --tail=60 hyper 查看详情。\n' >&2
  docker compose ps >&2 || true
  exit 1
fi

binding="$(docker compose port hyper 8788)"
if [[ ! "$binding" =~ ^127\.0\.0\.1:[0-9]{1,5}$ ]]; then
  printf '无法确认看板的本机监听地址，请检查 Compose 的端口映射。\n' >&2
  exit 1
fi

health_url="http://$binding/healthz"
if ! health="$(curl --noproxy 127.0.0.1 -fsS --max-time 10 "$health_url")" || [[ "$health" != "ok" ]]; then
  printf '容器已启动，但本机健康检查未返回 ok。\n' >&2
  exit 1
fi

printf '部署完成，本机健康检查已通过。\n'
