# 雷动远程资源（leidong-sftp）

远程资源管理器：**SFTP / SSH / FTP / FTPS** 文件传输、本地与远程文件比较/同步、交互式**远程终端**。

## 功能

- 📁 **远程资源视图**：远程目录浏览、文件预览、上传、下载、新建目录、重命名、删除
- ⚡ **自动上传**：保存后自动上传到远程（可按连接切换）
- 🔁 **比较与同步**：本地文件右键"比较本地与远程文件"、"同步当前文件（比较后选择）"
- 💾 **备份上传**：上传前备份远端旧文件
- 🖥️ **远程终端**：在"新建终端"下拉选择"雷动远程终端"，交互式 SSH Shell，支持命令收藏/历史提示
- ⌨️ **终端内置指令**：`/download`、`/upload` 等斜杠指令直接在终端操作文件
- 🔗 **终端联动**：终端 `cd` 到某目录，远程资源侧边栏自动展开到该目录
- 🧪 **连接测试**：单连接 / 全部连接批量诊断

## 终端内置指令

在远程终端中直接输入 `/指令`（在扩展本地执行，不发送到远端 shell）。本地路径按"远端相对 `remotePath` 的差值 → 工作区对应路径"映射：

| 指令 | 说明 |
|---|---|
| `/help` | 显示所有内置指令 |
| `/pwd` | 显示当前远程目录 |
| `/ls [路径]` | 列出远端目录 |
| `/download <文件>` | 下载远端文件到本地对应目录 |
| `/download-dir <目录>` | 下载远端目录到本地对应目录 |
| `/upload <文件>` | 上传本地文件到远端当前目录（本地不存在则跳过） |
| `/upload-dir <目录>` | 上传本地目录到远端当前目录 |
| `/open <文件>` | 下载远端文件并用编辑器打开 |
| `/cat <文件>` | 显示远端文件内容（上限 200KB） |
| `/tail <文件> [行数]` | 显示远端文件末尾（默认 50 行，上限 2MB） |
| `/mkdir <目录>` | 远端新建目录 |
| `/rm <路径>` | 删除远端文件或目录 |
| `/mv <源> <目标>` | 移动/重命名远端路径 |

**文件选择器**：路径参数以 `@` 开头时在终端内联弹出候选列表（Claude Code 式交互）：

| 输入 | 效果 |
|---|---|
| `/upload @` 或 `/upload @app/js` | 内联列出工作区本地文件（`/upload-dir @` 选目录） |
| `/download @` | 内联列出远端文件（`/open` `/cat` `/tail` `/rm` 同样支持） |

交互：继续输入过滤 → 方向键选择 → **Space 多选**（✓ 标记）→ Tab/回车确认执行；Esc 关闭。输入 `/` 停顿即可弹出指令列表选择内置指令。

示例：终端 `cd /var/www/html` 后输入 `/download index.html`，即可把远端文件下载到工作区对应位置。

## 使用

默认读取工作区 `.vscode/sftp.json`（带字段补全和校验）。配置既可以是单个对象，也可以是多个配置组成的数组：

```json
[
  {
    "name": "ku",
    "host": "xxxx",
    "protocol": "sftp",
    "port": 22,
    "username": "xxxxx",
    "password": "xxxxx",
    "remotePath": "/Data",
    "uploadOnSave": true
  }
]
```

右键本地文件可上传/下载/比较/同步；远程资源侧边栏提供完整管理操作。

## 配置

| 配置项 | 说明 |
|---|---|
| `leidong-tools.sftpConfigFiles` | 相对工作区的远程连接配置文件路径（默认 `.vscode/sftp.json`） |
| `leidong-tools.remoteConfigFiles` | 额外远程连接配置文件路径 |
| `leidong-tools.remoteConnectionIdleTimeout` | 连接空闲自动断开时间（秒）；`0` 表示一直保持连接（默认） |
| `leidong-tools.remoteVerboseProtocolLogging` | 输出远程协议详细日志 |
| `leidong-tools.remoteUploadExcludedExtensions` | 自动上传排除的扩展名 |
| `leidong-tools.remoteUploadOnSaveEnabled` | 保存后自动上传开关 |
| `leidong-tools.remoteUploadExcludeRegex` | 自动上传排除路径正则 |
| `leidong-tools.remoteTerminalFavoriteCommands` | 远程终端收藏命令 |

## 开发

```bash
npm install
npm run compile      # webpack 打包
npm run vsix         # 生成 .vsix
```

F5 启动扩展宿主调试（见 `.vscode/launch.json`）。
