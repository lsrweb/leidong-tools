# 雷动BYOK

为 Copilot Chat 提供 **DeepSeek / MiMo 等 OpenAI 兼容自定义模型端点（BYOK）**。模型列表、模型名称、端点地址、API Key 均可通过图形化面板自由配置。

## 功能

- 🧩 **自定义模型列表**：新增 / 编辑 / 删除模型，任意平台即插即用
- 🔌 **接口类型可选**：OpenAI 兼容 Chat Completions（默认）/ OpenAI 兼容 Responses / Anthropic 兼容 Messages，接入新平台无需改代码
- ✏️ **自定义模型名称**：每个模型的显示名称可在面板中随意修改，立即生效
- 🔑 **API Key 安全存储**：密钥保存在 VS Code SecretStorage，不会写入设置文件
- 🏷️ **官方端点预设**：DeepSeek 官方、MiMo 按量计费、MiMo TokenPlan（中国/新加坡/欧洲）一键填入
- 🖼️ **视觉代理**：为不支持图片输入的模型配置图片转文字代理（`leidong-models.setVisionModel`）
- 💰 **费用提示**：可配置每百万 token 定价，模型选择器显示费用档位

## 快速开始

1. 安装本扩展（需要 VS Code ≥ 1.116 和 GitHub Copilot Chat）。
2. 命令面板运行 **"雷动BYOK: 配置自定义模型"** 打开模型管理面板。
3. 默认已内置 3 个模型（DeepSeek V4 Flash / V4 Pro、MiMo V2.5 Pro）；为模型输入 API Key 并保存。
4. 在 Copilot Chat 的模型选择器中即可选择使用。

## 配置

所有配置位于 `leidong-models` 配置段：

| 配置项 | 说明 |
|---|---|
| `leidong-models.models` | 模型列表（数组）。`name` 为模型选择器中的显示名称；`baseUrl` 为 OpenAI 兼容端点；`apiModelId` 为空时使用 `id` 作为请求模型名 |
| `leidong-models.visionModel` / `visionPrompt` | 视觉代理使用的 VS Code 模型与提示词 |
| `leidong-models.debugMode` | 日志详细程度（minimal / metadata / verbose） |
| `leidong-models.experimental.stabilizeToolList` | 实验性工具列表稳定化 |

也可以在面板中完成所有配置，无需手写设置文件。

## 命令

| 命令 | 说明 |
|---|---|
| 雷动BYOK: 配置自定义模型 | 打开模型管理面板 |
| 雷动BYOK: 设置模型 API Key | 通过命令面板为某个模型设置密钥 |
| 雷动BYOK: 配置视觉代理 | 打开视觉代理配置面板 |
| 雷动BYOK: 显示模型日志 | 查看请求 / 错误日志 |
| 雷动BYOK: 打开模型设置 | 打开设置页 |

## 开发

```bash
npm install
npm run compile      # webpack 打包
npm run vsix         # 生成 .vsix
```

F5 启动扩展宿主调试（见 `.vscode/launch.json`）。

模型默认值与 `package.json` 中 `leidong-models.models` 的 `default` 互为镜像，修改一侧必须同步另一侧。
