#!/usr/bin/env bash
# Source this file from a build command; it does not edit shell startup files.

harmony_setup_environment() {
  local studio_path="${HARMONY_STUDIO_HOME:-${DEVECO_CLI_STUDIO_PATH:-/Applications/DevEco-Studio.app}}"
  studio_path="${studio_path%/}"
  studio_path="${studio_path%/Contents}"

  export HARMONY_STUDIO_HOME="$studio_path"
  export DEVECO_CLI_STUDIO_PATH="$studio_path"
  export HARMONY_NODE="$studio_path/Contents/tools/node/bin/node"
  export HARMONY_OHPM="$studio_path/Contents/tools/ohpm/bin/pm-cli.js"
  export HARMONY_HVIGOR="$studio_path/Contents/tools/hvigor/bin/hvigorw.js"
  export HARMONY_HDC="$studio_path/Contents/sdk/default/openharmony/toolchains/hdc"
  export JAVA_HOME="$studio_path/Contents/jbr/Contents/Home"
  export NODE_HOME="$studio_path/Contents/tools/node"
  export DEVECO_SDK_HOME="$studio_path/Contents/sdk"

  local required_path
  for required_path in "$HARMONY_NODE" "$HARMONY_OHPM" "$HARMONY_HVIGOR" "$JAVA_HOME/bin/java" "$HARMONY_HDC"; do
    if [[ ! -f "$required_path" ]]; then
      printf '缺少 HarmonyOS 开发工具：%s\n' "$required_path" >&2
      printf '请安装官方 DevEco Studio 26，或设置 HARMONY_STUDIO_HOME 为 .app 路径。\n' >&2
      return 1
    fi
  done
  if [[ ! -d "$DEVECO_SDK_HOME/default/openharmony/ets" ]]; then
    printf 'DevEco Studio 内置 ArkTS SDK 不完整：%s\n' "$DEVECO_SDK_HOME" >&2
    return 1
  fi
  export PATH="$JAVA_HOME/bin:$NODE_HOME/bin:$studio_path/Contents/tools/ohpm/bin:$studio_path/Contents/tools/hvigor/bin:$PATH"
}

harmony_setup_environment || return 1 2>/dev/null || exit 1

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'DevEco Studio: %s\nSDK: %s\n' "$HARMONY_STUDIO_HOME" "$DEVECO_SDK_HOME"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$HARMONY_STUDIO_HOME/Contents/Info.plist"
  "$HARMONY_NODE" --version
  "$JAVA_HOME/bin/java" -version
  "$HARMONY_NODE" "$HARMONY_OHPM" --version
  "$HARMONY_NODE" "$HARMONY_HVIGOR" --version
  "$HARMONY_HDC" -v
  printf '\n已连接的 HarmonyOS 设备：\n'
  "$HARMONY_HDC" list targets
fi
