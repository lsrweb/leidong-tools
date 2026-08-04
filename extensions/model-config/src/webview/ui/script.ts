/** Inline frontend script for the model configuration panel. */
export function getModelConfigPanelScript(): string {
	return `
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	let models = [];
	let hasApiKeys = {};
	let presets = [];
	let editing = null; // null | 'new' | modelId

	const $ = (id) => document.getElementById(id);

	// ---- helpers ----

	function escHtml(value) {
		return String(value)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;');
	}

	function escAttr(value) {
		return escHtml(value).replaceAll("'", '&#39;');
	}

	function toIntOrUndef(id) {
		const raw = $(id).value.trim();
		if (raw === '') {
			return undefined;
		}
		const value = Number.parseInt(raw, 10);
		return Number.isFinite(value) && value >= 0 ? value : undefined;
	}

	// ---- rendering ----

	function renderList() {
		const listEl = $('modelList');
		if (!listEl) {
			return;
		}
		if (models.length === 0) {
			listEl.innerHTML = '<p class="hint">尚未配置任何模型，点击"新增模型"开始。</p>';
			return;
		}
		listEl.innerHTML = models
			.map((m) => {
				const hasKey = !!hasApiKeys[m.id];
				const keyBadge = hasKey
					? '<span class="badge key-set">已设置密钥</span>'
					: '<span class="badge key-missing">未设置密钥</span>';
				return (
					'<div class="model-card" data-id="' +
					escAttr(m.id) +
					'">' +
					'<div class="grow">' +
					'<div class="name">' +
					escHtml(m.name) +
					'</div>' +
					'<div class="id">' +
					escHtml(m.id) +
					'</div>' +
					'<div class="meta">' +
					escHtml(m.baseUrl) +
					'</div>' +
					'</div>' +
					'<span class="badge">' +
					escHtml(m.family) +
					'</span>' +
					keyBadge +
					'<div class="card-actions">' +
					'<button class="ghost" data-act="edit">编辑</button>' +
					'<button class="ghost" data-act="delete">删除</button>' +
					'</div>' +
					'</div>'
				);
			})
			.join('');
	}

	function renderPresets() {
		const row = $('presetRow');
		if (!row) {
			return;
		}
		row.innerHTML = presets
			.map(
				(p) =>
					'<button type="button" data-preset-id="' +
					escAttr(p.id) +
					'">' +
					escHtml(p.label) +
					'</button>',
			)
			.join('');
	}

	function fillForm(m) {
		$('fName').value = m.name || '';
		$('fId').value = m.id || '';
		$('fFamily').value = m.family || 'deepseek';
		$('fApiType').value = m.apiType || 'chat-completions';
		$('fBaseUrl').value = m.baseUrl || '';
		$('fApiModelId').value = m.apiModelId || '';
		$('fMaxInput').value = m.maxInputTokens != null ? String(m.maxInputTokens) : '';
		$('fMaxOutput').value = m.maxOutputTokens != null ? String(m.maxOutputTokens) : '';
		$('fMaxTokens').value = m.maxTokens != null ? String(m.maxTokens) : '';
		const caps = m.capabilities || {};
		$('fToolCalling').value =
			typeof caps.toolCalling === 'number' ? String(caps.toolCalling) : '';
		$('fImageInput').checked = caps.imageInput === true;
		$('fThinking').checked = caps.thinking !== false;
		$('fThinkingEffort').value = m.thinkingEffort || 'high';
		const usd = (m.pricing && m.pricing.USD) || {};
		const cny = (m.pricing && m.pricing.CNY) || {};
		$('pUsdHit').value = usd.cacheHitInput != null ? String(usd.cacheHitInput) : '';
		$('pUsdMiss').value = usd.cacheMissInput != null ? String(usd.cacheMissInput) : '';
		$('pUsdOut').value = usd.output != null ? String(usd.output) : '';
		$('pCnyHit').value = cny.cacheHitInput != null ? String(cny.cacheHitInput) : '';
		$('pCnyMiss').value = cny.cacheMissInput != null ? String(cny.cacheMissInput) : '';
		$('pCnyOut').value = cny.output != null ? String(cny.output) : '';
		$('fPriceCat').value = m.priceCategory || '';
		$('fApiKey').value = '';
	}

	function openForm(m, isNew) {
		editing = isNew ? 'new' : m.id;
		$('fId').disabled = !isNew;
		$('fId').readOnly = !isNew;
		fillForm(m);
		$('formSection').hidden = false;
		updateKeyHint();
		updateFormKeyStatus();
	}

	function cancelForm() {
		editing = null;
		$('formSection').hidden = true;
		clearConfirm();
	}

	function updateKeyHint() {
		const family = $('fFamily').value;
		const baseUrl = $('fBaseUrl').value;
		let hint = 'sk-';
		if (family === 'mimo') {
			hint = baseUrl.includes('token-plan') ? 'tp-' : 'tp- / sk-';
		}
		$('keyHint').textContent =
			'密钥通常以 ' + hint + ' 开头；保存在 VS Code 安全存储中，不会写入设置文件。';
	}

	function updateFormKeyStatus() {
		const el = $('formKeyStatus');
		if (!el) {
			return;
		}
		if (editing === null || editing === 'new') {
			el.innerHTML = '<span class="badge key-missing">尚未保存密钥</span>保存模型时可一并输入密钥。';
			$('clearKeyButton').hidden = true;
			return;
		}
		const hasKey = !!hasApiKeys[editing];
		el.innerHTML = hasKey
			? '<span class="badge key-set">已设置密钥</span>输入新密钥可替换；也可清除。'
			: '<span class="badge key-missing">未设置密钥</span>保存时可输入密钥。';
		$('clearKeyButton').hidden = !hasKey;
	}

	// ---- actions ----

	function collectForm() {
		const capsToolCalling = $('fToolCalling').value.trim();
		const model = {
			id: $('fId').value.trim(),
			name: $('fName').value.trim(),
			family: $('fFamily').value,
			apiType: $('fApiType').value,
			baseUrl: $('fBaseUrl').value.trim(),
			apiModelId: $('fApiModelId').value.trim() || undefined,
			maxInputTokens: toIntOrUndef('fMaxInput'),
			maxOutputTokens: toIntOrUndef('fMaxOutput'),
			maxTokens: toIntOrUndef('fMaxTokens'),
			thinkingEffort: $('fThinkingEffort').value,
			capabilities: {
				toolCalling:
					capsToolCalling === '' ? true : Number.parseInt(capsToolCalling, 10),
				imageInput: $('fImageInput').checked,
				thinking: $('fThinking').checked,
			},
			pricing: collectPricing(),
			priceCategory: $('fPriceCat').value || undefined,
		};
		for (const key of Object.keys(model)) {
			if (model[key] === undefined) {
				delete model[key];
			}
		}
		return model;
	}

	function collectPricing() {
		const read = (id) => {
			const raw = $(id).value.trim();
			if (raw === '') {
				return undefined;
			}
			const value = Number(raw);
			return Number.isFinite(value) ? value : undefined;
		};
		const usd = {
			cacheHitInput: read('pUsdHit'),
			cacheMissInput: read('pUsdMiss'),
			output: read('pUsdOut'),
		};
		const cny = {
			cacheHitInput: read('pCnyHit'),
			cacheMissInput: read('pCnyMiss'),
			output: read('pCnyOut'),
		};
		const pricing = {};
		if (Object.values(usd).every((v) => v !== undefined)) {
			pricing.USD = usd;
		}
		if (Object.values(cny).every((v) => v !== undefined)) {
			pricing.CNY = cny;
		}
		return Object.keys(pricing).length > 0 ? pricing : undefined;
	}

	function save() {
		const model = collectForm();
		if (!model.id) {
			return showStatus('模型 ID 不能为空', true);
		}
		if (!model.name) {
			return showStatus('模型名称不能为空', true);
		}
		if (!model.baseUrl) {
			return showStatus('端点地址不能为空', true);
		}
		const apiKey = $('fApiKey').value.trim();
		vscode.postMessage({
			type: 'save',
			value: { model, apiKey: apiKey || undefined },
		});
	}

	function clearConfirm() {
		document.querySelectorAll('.model-card.confirming').forEach((card) => {
			card.classList.remove('confirming');
			const button = card.querySelector('[data-act="delete"]');
			if (button) {
				button.textContent = '删除';
			}
		});
	}

	function showStatus(message, isError, isSuccess) {
		const el = $('status');
		if (!el) {
			return;
		}
		el.textContent = message;
		el.classList.toggle('error', !!isError);
		el.classList.toggle('success', !!isSuccess);
		el.hidden = !message;
	}

	// ---- events ----

	document.addEventListener('click', (event) => {
		const presetButton = event.target.closest('[data-preset-id]');
		if (presetButton) {
			const preset = presets.find((p) => p.id === presetButton.dataset.presetId);
			if (preset) {
				$('fBaseUrl').value = preset.baseUrl;
				$('fFamily').value = preset.family;
				updateKeyHint();
			}
			return;
		}

		const card = event.target.closest('.model-card');
		const actionButton = event.target.closest('[data-act]');
		if (card && actionButton) {
			const action = actionButton.dataset.act;
			if (action === 'edit') {
				clearConfirm();
				const model = models.find((m) => m.id === card.dataset.id);
				if (model) {
					openForm(model, false);
				}
			} else if (action === 'delete') {
				if (card.classList.contains('confirming')) {
					const id = card.dataset.id;
					vscode.postMessage({ type: 'delete', value: { id } });
				} else {
					clearConfirm();
					card.classList.add('confirming');
					actionButton.textContent = '确认删除';
				}
			}
			return;
		}

		if (event.target.id === 'addButton') {
			clearConfirm();
			openForm(
				{
					name: '',
					id: '',
					family: 'deepseek',
					baseUrl: 'https://api.deepseek.com',
					capabilities: { toolCalling: 128, imageInput: false, thinking: true },
					thinkingEffort: 'high',
				},
				true,
			);
		} else if (event.target.id === 'cancelButton') {
			cancelForm();
		} else if (event.target.id === 'clearKeyButton') {
			if (editing && editing !== 'new') {
				vscode.postMessage({ type: 'clearApiKey', value: { id: editing } });
			}
		}
	});

	$('saveButton').addEventListener('click', save);
	$('fFamily').addEventListener('change', updateKeyHint);
	$('fBaseUrl').addEventListener('input', updateKeyHint);
	$('modelForm').addEventListener('submit', (event) => {
		event.preventDefault();
		save();
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || typeof message.type !== 'string') {
			return;
		}
		if (message.type === 'state') {
			models = message.value.models || [];
			hasApiKeys = message.value.hasApiKeys || {};
			presets = message.value.presets || [];
			renderList();
			renderPresets();
			if (editing !== null && editing !== 'new') {
				if (models.some((m) => m.id === editing)) {
					// editing model still exists; refresh the key badge
					updateFormKeyStatus();
				} else {
					cancelForm();
				}
			}
		} else if (message.type === 'status') {
			const value = message.value || {};
			showStatus(value.message || '', value.error, value.success);
		}
	});

	// ---- init ----

	models = INITIAL_STATE.models || [];
	hasApiKeys = INITIAL_STATE.hasApiKeys || {};
	presets = INITIAL_STATE.presets || [];
	renderPresets();
	renderList();
	updateKeyHint();
})();
`;
}
