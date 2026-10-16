# 多 Server 与 SSH 机器配置

鸿蒙 App 可以保存多个 Server 网关，首页按 Server 分组显示本机与 SSH 远程机器。网页支持选择当前网关下的机器。选择机器后，工作路径、会话、模型、审批和图片均来自该机器。

## 配置 Server

现有 `config.local.json` 的 `socketPath` 与 `projects` 继续定义本机目标 `local`，已有配对授权和旧客户端继续有效。新增 `sshTargets` 配置远程目标，例如：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "publicUrl": "https://your-server.your-tailnet.ts.net",
  "projects": [{ "name": "本机项目", "path": "/Users/me/Code/project" }],
  "sshTargets": [
    {
      "id": "workstation",
      "name": "工作电脑",
      "sshHost": "workstation",
      "socketPath": "/Users/me/.codex/app-server-control/app-server-control.sock",
      "projects": [{ "name": "远程项目", "path": "/Users/me/Code/project" }],
      "uploadDir": "/Users/me/.codex-phone/uploads"
    },
    {
      "id": "linux-dev",
      "name": "Linux 开发机",
      "sshHost": "linux-dev",
      "socketPath": "/home/me/.codex/app-server-control/app-server-control.sock",
      "projects": [{ "name": "开发项目", "path": "/home/me/work/project" }],
      "uploadDir": "/home/me/.codex-phone/uploads"
    }
  ]
}
```

示例路径必须替换为真实路径。`id` 是稳定的小写标识，使用字母、数字、下划线和连字符，不得重复或使用保留值 `local`。客户端缓存与上传记录按此标识隔离；同一标识应始终指向同一机器和 SSH 用户，换目标时使用新标识。

`sshHost` 引用运行网关的用户的 SSH 配置别名。目标路径为目标机上的 POSIX 绝对路径，不是网关路径，不使用 `~`。远端目录不可用只影响对应目标。每个目标的 `projects` 限制新建会话可选工作目录，现有会话浏览仍使用后端返回的历史工作路径。

修改配置后重新加载网关；本机 LaunchAgent 的启停命令见 [Funnel 服务维护](FUNNEL-SERVICE.md)。网关会独立维护各目标连接，手机断线或网关停止不会停止 Codex 任务。

## SSH 前提

在 Server 的同一用户环境下准备 SSH 别名、非交互认证及已确认的主机密钥。例如：

```sshconfig
Host workstation
    HostName workstation.example
    User me
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

支持 SSH 配置中的跳板或代理设置。需要密码、主机密钥确认或其他交互登录时，应先在 Server 终端完成；手机不保存 SSH 私钥，也不弹出 SSH 密码输入框。登录启动服务的环境可能与交互终端不同，密钥及代理工具必须在后台环境中同样可用。

先确认实际非交互登录：

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes workstation 'uname -s; id -un'
```

目标机必须已经运行可提供共享 control socket 的 Codex。SSH 登录成功、安装了 Codex CLI、存在历史文件，都不能单独证明共享后端可用。网关通过 SSH 转发现有 Unix socket，完成协议握手和只读会话列表验证后，才将该目标标记为可用；每次后端重连都会重新验证。它不会启动独立 Codex 后端或以历史文件替代实时连接。

首版支持 macOS、Linux 的 Unix socket。目标 SSH 服务需要允许 Unix socket 转发。连接失败时按机器状态区分 SSH 不可达、认证失败、转发失败和 Codex 后端不可用。

## 图片

`uploadDir` 是专用于该网关上传图片的远端目录。SSH 用户需要创建或写入该目录的权限，目标需提供 SFTP 子系统。首次上传会逐级创建缺失目录，只将专用上传目录设置为 `0700`，不修改已有父目录的权限。图片先在网关校验并保存，再以临时文件传输，设置为 `0600` 并重命名后交给 Codex。

不要把此目录配置为共享文件根目录。已引用图片保留，消息历史通过网关保存的图片和远端路径映射回显；只清理本项目记录的过期未引用文件。网关不读取其他客户端图片对应的任意远端文件。

未配置图片目录或 SFTP 不可用时，文字、历史与实时控制仍可工作，图片不可用原因在客户端显示。SFTP 就绪探测仅执行只读操作，目录的实际写入权限在首次上传时验证。一次发送的全部图片准备最多等待 30 秒；失败或超时后不会继续提交对话，网关会暂时禁用该目标的图片功能并在 30 秒后重新探测。恢复后可核对草稿并重试。设备连接中断导致发送结果未知时，先查看会话确认是否已经发送。

## 手机操作与迁移

在 Server 管理中添加地址和名称，用该网关生成的一次性凭据配对。每个 Server 的登录独立保存，添加多个 Server 不再淘汰早期登录。升级会迁移已有入口，保留安装身份和设备授权。

首页按 Server 分组显示机器，选择后进入工作路径和会话。离线 Server 与机器仍保留，恢复后可刷新进入。首页可见时定时刷新目录，只有当前机器建立聊天实时连接。

不同 Server、不同机器的同名目录和会话分别管理；草稿、附件、图片及审批不会跨机器复用。删除 Server 配置只删除手机上的该项记录；要撤销远端授权，使用该网关的已授权客户端管理。

网页使用当前网关的机器选择器，不跨站保存多个 Server。旧网关在新版手机中作为单一本机目标兼容；同一机器经不同 Server 接入时分别展示为不同入口。

## 诊断与维护

`npm run doctor` 检查本机与已配置目标；检查单一目标时使用 `npm run doctor -- --target workstation`，检查本机时使用 `npm run doctor -- --target local`。诊断只进行连接、握手和只读查询，不创建会话、启动 Codex、创建远端目录或上传图片。

| 现象                     | 处理                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| Server 无法访问          | 先检查网关服务和 Funnel，与该 Server 下单台机器故障分别处理            |
| SSH 失败                 | 在运行网关的同一用户下验证非交互 SSH、密钥、主机指纹、跳板和网络       |
| SSH 正常但 Codex 不可用  | 核对目标用户、socket 绝对路径与 Codex 运行状态，检查是否允许转发       |
| 能读历史但当前任务不可控 | 验证是否连接同一个共享后端，检查会话执行器能力；不要据历史可读判定成功 |
| 文字正常但图片不可用     | 检查 `uploadDir`、SFTP 子系统、目录权限和可用空间                      |
| 某个 Server 登录失效     | 只对该 Server 重新配对，其他 Server 登录继续保留                       |

配置与设备认证数据属于本机文件，不提交 Git。复制部署时保留网关数据目录以及稳定的目标标识，才能保留设备授权和历史图片映射。
