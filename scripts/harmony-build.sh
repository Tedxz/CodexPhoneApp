#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"
build_mode="${1:-debug}"
if [[ "$build_mode" != debug && "$build_mode" != release ]] || [[ "$#" -gt 1 ]]; then
  printf '用法：bash scripts/harmony-build.sh [debug|release]\n' >&2
  exit 2
fi

source "$script_dir/harmony-env.sh"
cd "$repo_dir/harmony"
"$HARMONY_NODE" "$HARMONY_OHPM" install --all
"$HARMONY_NODE" "$HARMONY_HVIGOR" --mode module -p product=default -p module=entry@default -p "buildMode=$build_mode" assembleHap --no-daemon

hap_dir="$repo_dir/harmony/entry/build/default/outputs/default"
shopt -s nullglob
hap_files=("$hap_dir"/*.hap)
if [[ "${#hap_files[@]}" -eq 0 ]]; then
  printf '构建命令结束，但未找到 HAP：%s\n' "$hap_dir" >&2
  exit 1
fi
for hap_file in "${hap_files[@]}"; do
  unzip -tq "$hap_file"
  printf '\nHAP: %s\n' "$hap_file"
  shasum -a 256 "$hap_file"
done
