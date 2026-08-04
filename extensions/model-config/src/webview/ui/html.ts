import { randomBytes } from 'crypto';
import vscode from 'vscode';
import type { EndpointPreset } from '../../consts';
import type { ChatModelConfig } from '../../types';
import { getModelConfigPanelScript } from './script';
import { getModelConfigPanelStyle } from './style';

export interface ModelConfigPanelState {
	models: ChatModelConfig[];
	hasApiKeys: Record<string, boolean>;
	presets: readonly EndpointPreset[];
}

export function getModelConfigPanelHtml(
	webview: vscode.Webview,
	state: ModelConfigPanelState,
): string {
	const nonce = createNonce();
	const htmlLang = vscode.env.language.toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en';
	const initialState = escapeScriptJson(state);
	const csp = [
		"default-src 'none'",
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		`img-src ${webview.cspSource} data:`,
	].join('; ');

	return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>自定义模型配置</title>
	<style nonce="${nonce}">${getModelConfigPanelStyle()}</style>
</head>
<body>
	<header>
		<h1>自定义模型配置</h1>
		<p class="intro">为 Copilot Chat 提供 OpenAI 兼容的自定义模型端点（BYOK）。模型名称显示在 Copilot Chat 的模型选择器中，可自由修改。</p>
		<p class="migrate-hint">🔑 API Key 保存在 VS Code 安全存储中，不会写入设置文件。从旧版"雷动三千工具集"升级的用户需要在本面板中重新设置密钥（旧密钥无法自动迁移）。</p>
	</header>

	<div id="status" class="status" hidden></div>

	<section id="listSection">
		<div class="toolbar">
			<button id="addButton" class="primary">＋ 新增模型</button>
		</div>
		<div id="modelList" class="model-list"></div>
	</section>

	<div id="formSection" class="modal-overlay" hidden>
		<div class="modal-dialog">
			<h2 id="formTitle">新增模型</h2>
			<form id="modelForm">
				<div class="field-row">
					<div class="field">
						<label for="fName">显示名称 *</label>
						<input id="fName" type="text" placeholder="例如：DeepSeek V4 Flash">
						<div class="hint">显示在 Copilot Chat 模型选择器中的名称。</div>
					</div>
					<div class="field">
						<label for="fId">模型 ID *</label>
						<input id="fId" type="text" placeholder="例如：deepseek-v4-flash">
						<div class="hint">唯一标识（编辑时不可修改，避免密钥错位）。</div>
					</div>
				</div>
				<div class="field-row">
					<div class="field">
						<label for="fFamily">平台 / 家族</label>
						<input id="fFamily" type="text" list="familyList" placeholder="deepseek / mimo / 其他任意平台">
						<datalist id="familyList">
							<option value="deepseek">
							<option value="mimo">
							<option value="openai">
							<option value="qwen">
							<option value="glm">
							<option value="kimi">
							<option value="gemini">
						</datalist>
						<div class="hint">决定思考强度预设；未知平台按标准 OpenAI 兼容发送请求，无需适配。</div>
					</div>
					<div class="field">
						<label for="fApiType">接口类型</label>
						<select id="fApiType">
							<option value="chat-completions">OpenAI 兼容 Chat Completions</option>
							<option value="responses">OpenAI 兼容 Responses</option>
							<option value="anthropic-messages">Anthropic 兼容 Messages</option>
						</select>
						<div class="hint">按平台提供的接口选择；Chat Completions 兼容性最好。</div>
					</div>
				</div>
				<div class="field-row">
					<div class="field">
						<label for="fBaseUrl">端点地址 *</label>
						<input id="fBaseUrl" type="text" placeholder="https://api.deepseek.com">
						<div class="preset-row" id="presetRow"></div>
					</div>
					<div class="field">
						<label for="fApiModelId">API 模型 ID</label>
						<input id="fApiModelId" type="text" placeholder="留空则使用模型 ID">
						<div class="hint">发送给端点的实际模型 ID；用于兼容网关或官方模型更新。</div>
					</div>
				</div>

			<details>
				<summary>高级选项</summary>
				<div class="field-row">
					<div class="field">
						<label for="fMaxInput">最大输入 tokens</label>
						<input id="fMaxInput" type="number" min="0">
					</div>
					<div class="field">
						<label for="fMaxOutput">最大输出 tokens</label>
						<input id="fMaxOutput" type="number" min="0">
					</div>
					<div class="field">
						<label for="fMaxTokens">单次请求输出上限</label>
						<input id="fMaxTokens" type="number" min="0">
						<div class="hint">0 表示交由 API 决定。</div>
					</div>
				</div>
				<div class="field">
					<label>能力</label>
					<div class="checkbox-row">
						<label><input id="fThinking" type="checkbox"> 深度思考</label>
						<label><input id="fImageInput" type="checkbox"> 图片输入</label>
					</div>
				</div>
				<div class="field-row">
					<div class="field">
						<label for="fToolCalling">工具调用数量上限</label>
						<input id="fToolCalling" type="number" min="0" placeholder="留空则使用默认（支持工具调用）">
						<div class="hint">数值为单次请求最多 functions 数。</div>
					</div>
					<div class="field">
						<label for="fThinkingEffort">默认思考强度</label>
						<select id="fThinkingEffort">
							<option value="high">高（推荐）</option>
							<option value="medium">中</option>
							<option value="low">低</option>
							<option value="none">关闭</option>
						</select>
					</div>
					<div class="field">
						<label for="fPriceCat">费用档位</label>
						<select id="fPriceCat">
							<option value="">不显示</option>
							<option value="low">低</option>
							<option value="medium">中等</option>
							<option value="high">高</option>
							<option value="very_high">很高</option>
						</select>
					</div>
				</div>
				<div class="field">
					<label>定价（每百万 tokens）</label>
					<div class="field-row">
						<div class="field">
							<div class="hint">USD</div>
							<input id="pUsdHit" type="number" step="any" min="0" placeholder="缓存输入">
							<input id="pUsdMiss" type="number" step="any" min="0" placeholder="非缓存输入">
							<input id="pUsdOut" type="number" step="any" min="0" placeholder="输出">
						</div>
						<div class="field">
							<div class="hint">CNY</div>
							<input id="pCnyHit" type="number" step="any" min="0" placeholder="缓存输入">
							<input id="pCnyMiss" type="number" step="any" min="0" placeholder="非缓存输入">
							<input id="pCnyOut" type="number" step="any" min="0" placeholder="输出">
						</div>
					</div>
					<div class="hint">六个字段全部填写才会显示费用提示。</div>
				</div>
			</details>

			<div class="field">
				<label for="fApiKey">API Key（可选）</label>
				<input id="fApiKey" type="password" placeholder="输入后随模型一起保存到安全存储">
				<div id="keyHint" class="hint"></div>
				<div id="formKeyStatus" class="key-status"></div>
				<button id="clearKeyButton" type="button" class="secondary" hidden>清除已保存的 API Key</button>
			</div>

				<div class="form-actions">
					<button id="saveButton" type="button" class="primary">保存</button>
					<button id="cancelButton" type="button" class="secondary">取消</button>
				</div>
			</form>
		</div>
	</div>

	<script nonce="${nonce}">
		const INITIAL_STATE = ${initialState};
		${getModelConfigPanelScript()}
	</script>
</body>
</html>
`;
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

function escapeScriptJson(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll('<', '\\u003c')
		.replaceAll(' ', '\\u2028')
		.replaceAll(' ', '\\u2029');
}
