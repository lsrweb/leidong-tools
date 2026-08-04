# 更新日志 (Changelog)

## [0.1.3] - 2026-08-01

### ⬇️ 兼容性

- 最低兼容 VS Code 版本调整为 1.108（语言模型工具 API 的稳定版本下限），`@types/vscode` 同步锁定。

## [0.1.2] - 2026-08-01

### ✨ 模型配置能力完善

- 支持选择**接口类型**：OpenAI 兼容 Chat Completions / OpenAI 兼容 Responses / Anthropic 兼容 Messages（消息转换、SSE 解析、鉴权头按协议自动处理）。
- 平台标签 `family` 改为自由输入（openai / qwen / glm / kimi 等任意值），未知平台按标准 OpenAI 兼容处理，接入新平台无需改代码。
- MiMo V2.5 Pro 补充计费显示（官方降价后与 DeepSeek V4 Pro 同价）。
- 模型配置表单改为弹窗样式，去掉副标题等冗余字段。

## [0.1.0] - 2026-08-01

### 🧩 从雷动三千工具集拆分

- Copilot Chat 自定义端点（BYOK）从主扩展拆分为独立扩展：模型注册、API Key 安全存储、请求实现、视觉代理完整迁移。
- 提供可视化模型管理面板（新增/编辑/删除模型、自定义模型名称、官方端点预设）。
- 旧版 `leidong-tools.copilot.*` 设置首次激活自动迁移。
