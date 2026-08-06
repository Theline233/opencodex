#!/usr/bin/env bash
set -eEuo pipefail

action=${1:-status}
release=${2:-}
archive=${3:-}
expected_sha=${4:-}

deploy_root="$HOME/.local/share/opencodex-deploy"
release_root="$deploy_root/releases"
staging_root="$deploy_root/staging"
canary_root="$deploy_root/canary"
log_root="$deploy_root/logs"
current_link="$deploy_root/current"
previous_link="$deploy_root/previous"
unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/opencodex-proxy.service"
config_root="$HOME/.opencodex"
production_port=10100
canary_port=10101
cleanup_staging=""
cleanup_canary_home=""
cleanup_canary_pid=""
prepared_release_dir=""

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

safe_remove_dir() {
  local target=$1
  case "$target" in
    "$staging_root"/*|"$canary_root"/*) rm -rf -- "$target" ;;
    *) fail "refusing to remove unexpected path: $target" ;;
  esac
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "$cleanup_canary_pid" ]; then
    kill "$cleanup_canary_pid" 2>/dev/null || true
    wait "$cleanup_canary_pid" 2>/dev/null || true
  fi
  if [ -n "$cleanup_canary_home" ]; then safe_remove_dir "$cleanup_canary_home"; fi
  if [ -n "$cleanup_staging" ]; then safe_remove_dir "$cleanup_staging"; fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

atomic_link() {
  local target=$1
  local link=$2
  local pending="${link}.next.$$"
  rm -f -- "$pending"
  ln -s "$target" "$pending"
  mv -Tf -- "$pending" "$link"
}

wait_for_health() {
  local port=$1
  local attempts=${2:-45}
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

find_bootstrap_bun() {
  local candidate
  for candidate in \
    "$current_link/node_modules/bun/bin/bun.exe" \
    "/usr/local/lib/node_modules/@bitkyc08/opencodex/node_modules/bun/bin/bun.exe" \
    "$(command -v bun 2>/dev/null || true)"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  fail "Bun runtime not found"
}

write_stable_unit() {
  mkdir -p "$unit_dir"
  local temp="$unit_path.next.$$"
  cat > "$temp" <<EOF
[Unit]
Description=OpenCodex Proxy Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="/bin/sh" -lc "if [ -f '$config_root/service-api-token' ]; then OPENCODEX_API_AUTH_TOKEN=\"\$(cat '$config_root/service-api-token')\"; export OPENCODEX_API_AUTH_TOKEN; fi; exec '$current_link/node_modules/bun/bin/bun.exe' '$current_link/src/cli/index.ts' start --port $production_port"
Restart=on-failure
RestartSec=5
Environment="OCX_SERVICE=1"
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"
StandardOutput=append:$config_root/service.log
StandardError=append:$config_root/service.log

[Install]
WantedBy=default.target
EOF
  chmod 0644 "$temp"
  mv -f -- "$temp" "$unit_path"
}

run_probe() {
  local release_dir=$1
  local port=$2
  local bun="$release_dir/node_modules/bun/bin/bun.exe"
  timeout 60s "$bun" "$release_dir/ops/tokyo/canary-probe.ts" \
    --url "http://127.0.0.1:$port" \
    --config "$config_root/config.json"
}

assert_release_complete() {
  local release_dir=$1
  [ -x "$release_dir/node_modules/bun/bin/bun.exe" ] || fail "release Bun runtime is missing"
  [ -f "$release_dir/src/cli/index.ts" ] || fail "release CLI entry point is missing"
  [ -s "$release_dir/gui/dist/index.html" ] || fail "release GUI index is missing"
  find "$release_dir/gui/dist/assets" -maxdepth 1 -type f -size +0c -print -quit \
    | grep -q . || fail "release GUI assets are missing"
}

prepare_release() {
  [[ "$release" =~ ^[A-Za-z0-9._-]+$ ]] || fail "invalid release id"
  [ -f "$archive" ] || fail "archive not found: $archive"
  [ -n "$expected_sha" ] || fail "expected SHA-256 is required"
  local actual_sha
  actual_sha=$(sha256sum "$archive" | awk '{print $1}')
  [ "$actual_sha" = "$expected_sha" ] || fail "archive SHA-256 mismatch"

  mkdir -p "$release_root" "$staging_root" "$canary_root" "$log_root"
  local release_dir="$release_root/$release"
  if [ -f "$release_dir/.opencodex-release" ]; then
    assert_release_complete "$release_dir"
    prepared_release_dir="$release_dir"
    echo "RELEASE_REUSED path=$release_dir"
    return 0
  fi
  [ ! -e "$release_dir" ] || fail "release path exists without a completion marker"

  local staging="$staging_root/${release}.$$"
  safe_remove_dir "$staging"
  mkdir -p "$staging"
  cleanup_staging="$staging"
  tar -xzf "$archive" -C "$staging"

  local bootstrap_bun
  bootstrap_bun=$(find_bootstrap_bun)
  (
    cd "$staging"
    "$bootstrap_bun" install --frozen-lockfile
    cd gui
    "$bootstrap_bun" install --frozen-lockfile
    # Vite 8 requires Node 20+, while this server intentionally keeps Node 18.
    # Force package shebangs through the release-pinned Bun runtime.
    "$bootstrap_bun" --bun run build
  )
  local release_bun="$staging/node_modules/bun/bin/bun.exe"
  [ -x "$release_bun" ] || fail "release Bun runtime was not installed"
  "$release_bun" test "$staging/tests/sse-payload-rewrite.test.ts" "$staging/tests/responses-snapshot-repair.test.ts"
  assert_release_complete "$staging"
  printf 'release=%s\nsha256=%s\nprepared_at=%s\n' \
    "$release" "$actual_sha" "$(date -Iseconds)" > "$staging/.opencodex-release"
  mv -- "$staging" "$release_dir"
  cleanup_staging=""
  prepared_release_dir="$release_dir"
  echo "RELEASE_PREPARED path=$release_dir"
}

validate_canary() {
  local release_dir=$1
  local canary_home="$canary_root/$release"
  local canary_log="$log_root/${release}-canary.log"
  safe_remove_dir "$canary_home"
  mkdir -p "$canary_home"
  cleanup_canary_home="$canary_home"
  install -m 0600 "$config_root/config.json" "$canary_home/config.json"

  (
    export OPENCODEX_HOME="$canary_home"
    if [ -f "$config_root/service-api-token" ]; then
      OPENCODEX_API_AUTH_TOKEN=$(cat "$config_root/service-api-token")
      export OPENCODEX_API_AUTH_TOKEN
    fi
    exec "$release_dir/node_modules/bun/bin/bun.exe" \
      "$release_dir/src/cli/index.ts" start --port "$canary_port"
  ) > "$canary_log" 2>&1 &
  cleanup_canary_pid=$!

  if ! wait_for_health "$canary_port" 45; then
    tail -n 80 "$canary_log" >&2 || true
    fail "canary did not become healthy"
  fi
  run_probe "$release_dir" "$canary_port"
  echo "CANARY_OK release=$release"
  kill "$cleanup_canary_pid" 2>/dev/null || true
  wait "$cleanup_canary_pid" 2>/dev/null || true
  cleanup_canary_pid=""
  safe_remove_dir "$canary_home"
  cleanup_canary_home=""
}

activate_release() {
  local release_dir=$1
  local fallback="/usr/local/lib/node_modules/@bitkyc08/opencodex"
  local previous_target
  if [ -L "$current_link" ]; then
    previous_target=$(readlink -f "$current_link")
  else
    [ -d "$fallback" ] || fail "current release and legacy fallback are both missing"
    previous_target="$fallback"
  fi

  local unit_backup="$deploy_root/unit-before-${release}.service"
  if [ -f "$unit_path" ]; then
    cp -p -- "$unit_path" "$unit_backup"
  fi
  atomic_link "$previous_target" "$previous_link"
  atomic_link "$release_dir" "$current_link"
  write_stable_unit
  systemctl --user daemon-reload

  rollback_activation() {
    local rc=$?
    trap - ERR
    echo "ACTIVATION_FAILED release=$release rc=$rc; rolling back" >&2
    atomic_link "$previous_target" "$current_link"
    if [ -f "$unit_backup" ]; then cp -p -- "$unit_backup" "$unit_path"; fi
    systemctl --user daemon-reload
    systemctl --user restart opencodex-proxy.service || true
    wait_for_health "$production_port" 45 || true
    exit "$rc"
  }
  trap rollback_activation ERR

  systemctl --user restart opencodex-proxy.service
  wait_for_health "$production_port" 45
  run_probe "$release_dir" "$production_port"
  systemctl --user is-active --quiet opencodex-proxy.service
  trap - ERR

  printf 'release=%s\npath=%s\nprevious=%s\nactivated_at=%s\n' \
    "$release" "$release_dir" "$previous_target" "$(date -Iseconds)" > "$deploy_root/active-release"
  echo "PRODUCTION_OK release=$release"
}

rollback_release() {
  [ -L "$current_link" ] || fail "current release link is missing"
  [ -L "$previous_link" ] || fail "previous release link is missing"
  local current_target previous_target
  current_target=$(readlink -f "$current_link")
  previous_target=$(readlink -f "$previous_link")
  [ -d "$previous_target" ] || fail "previous release path is missing: $previous_target"

  atomic_link "$previous_target" "$current_link"
  atomic_link "$current_target" "$previous_link"
  if ! systemctl --user restart opencodex-proxy.service || ! wait_for_health "$production_port" 45; then
    atomic_link "$current_target" "$current_link"
    atomic_link "$previous_target" "$previous_link"
    systemctl --user restart opencodex-proxy.service || true
    wait_for_health "$production_port" 45 || true
    fail "rollback target failed health check; restored the newer release"
  fi
  printf 'release=%s\npath=%s\nprevious=%s\nrolled_back_at=%s\n' \
    "$(basename "$previous_target")" "$previous_target" "$current_target" "$(date -Iseconds)" \
    > "$deploy_root/active-release"
  echo "ROLLBACK_OK current=$previous_target previous=$current_target"
}

show_status() {
  echo "service=$(systemctl --user is-active opencodex-proxy.service 2>/dev/null || true)"
  echo "current=$(readlink -f "$current_link" 2>/dev/null || echo legacy-global-install)"
  echo "previous=$(readlink -f "$previous_link" 2>/dev/null || echo none)"
  if curl -fsS --max-time 2 "http://127.0.0.1:$production_port/healthz" >/dev/null 2>&1; then
    echo "health=ok"
  else
    echo "health=failed"
  fi
  [ -f "$deploy_root/active-release" ] && cat "$deploy_root/active-release"
  return 0
}

case "$action" in
  deploy)
    # Keep this as a plain function call: Bash disables errexit inside functions
    # used in command substitutions, which could otherwise hide a failed build.
    prepare_release
    [ -n "$prepared_release_dir" ] || fail "release preparation returned no path"
    validate_canary "$prepared_release_dir"
    activate_release "$prepared_release_dir"
    ;;
  rollback) rollback_release ;;
  status) show_status ;;
  *) fail "unknown action: $action" ;;
esac
