# 原生图标

应用图标位于 `harmony/AppScope/resources/base/media/app_icon.svg`，桌面图标、启动页和 App 内品牌标识共用此资源。

Codex 花形轮廓与 `>_` 使用本机官方安装包 `/Applications/ChatGPT.app/Contents/Resources/app.asar` 中的 `webview/assets/codex_new-f14177b03534.svg`（2026-10-16 提取）。保留原始三条几何路径，外形使用实心轮廓；仅调整整体缩放和配色。背景为 `#F6F7F2`，绿色渐变为 `#73947C` → `#315D4B` → `#243A32`，终端标识为白色。

添加连接使用独立矢量 `harmony/entry/src/main/resources/base/media/add_connection.svg`，避免字体加号在按钮内偏移或裁切。按钮为 88 × 46 vp，包含 20 vp 图形与“连接”文字，可访问性名称为“添加连接”。

unsigned / signed HAP 编译通过，签名包已覆盖安装到 Mate 90 Pro Max；实际检查了桌面图标、App 内标识、按钮显示，以及点击进入添加连接页后返回。登录保留，两台机器仍连接。此次为视觉改动，没有新增与实现重复的测试。

- [真机首页](evidence/2026-10-16-icons/phone-overview.png)
- [图标尺寸与布局预览](evidence/2026-10-16-icons/icons-preview.png)（浏览器近似渲染）
- [构建、安装和操作验证](evidence/2026-10-16-icons/report.json)
