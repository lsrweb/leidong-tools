/** Inline stylesheet for the model configuration panel. */
export function getModelConfigPanelStyle(): string {
	return `
* { box-sizing: border-box; }
body {
	margin: 0;
	padding: 16px 20px;
	color: var(--vscode-editor-foreground);
	background: var(--vscode-editor-background);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
}
h1 { font-size: 1.3em; margin: 0 0 4px; }
h2 { font-size: 1.05em; margin: 0 0 8px; }
p.intro { color: var(--vscode-descriptionForeground); margin: 0 0 12px; line-height: 1.5; }
p.migrate-hint {
	color: var(--vscode-descriptionForeground);
	margin: 0 0 12px;
	padding: 8px 10px;
	border: 1px solid var(--vscode-widget-border, #3c3c3c);
	border-radius: 4px;
	background: var(--vscode-editorWidget-background, transparent);
	line-height: 1.5;
}

.status {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	margin-bottom: 12px;
	padding: 8px 10px;
	border-radius: 4px;
	background: var(--vscode-inputValidation-infoBackground, #062a37);
	border: 1px solid var(--vscode-inputValidation-infoBorder, #1c7a9b);
	line-height: 1.5;
	white-space: pre-wrap;
}
.status[hidden] { display: none; }
.status.error {
	background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
	border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}
.status.success {
	background: var(--vscode-inputValidation-warningBackground, #352a05);
	border-color: var(--vscode-inputValidation-warningBorder, #b89500);
}

.toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
button {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	border-radius: 2px;
	padding: 5px 12px;
	cursor: pointer;
	font-size: var(--vscode-font-size);
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.ghost {
	background: transparent;
	color: var(--vscode-textLink-foreground);
	padding: 2px 6px;
}
button.ghost:hover { text-decoration: underline; background: transparent; }
button:disabled { opacity: 0.5; cursor: default; }

.model-list { display: flex; flex-direction: column; gap: 8px; }
.model-card {
	border: 1px solid var(--vscode-widget-border, #3c3c3c);
	border-radius: 4px;
	padding: 10px 12px;
	display: flex;
	align-items: center;
	gap: 12px;
	background: var(--vscode-editorWidget-background, transparent);
}
.model-card .grow { flex: 1; min-width: 0; }
.model-card .name { font-weight: 600; }
.model-card .id { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 2px; }
.model-card .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
	display: inline-block;
	padding: 1px 8px;
	border-radius: 10px;
	font-size: 0.8em;
	border: 1px solid var(--vscode-widget-border, #3c3c3c);
	color: var(--vscode-descriptionForeground);
	white-space: nowrap;
}
.badge.key-set { color: var(--vscode-charts-green, #89d185); border-color: currentColor; }
.badge.key-missing { color: var(--vscode-errorForeground, #f48771); border-color: currentColor; }
.card-actions { display: flex; gap: 4px; }

.modal-overlay {
	position: fixed;
	inset: 0;
	z-index: 10;
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding: 48px 16px;
	background: rgba(0, 0, 0, 0.45);
	overflow-y: auto;
}
.modal-overlay[hidden] { display: none; }
.modal-dialog {
	width: 100%;
	max-width: 640px;
	border: 1px solid var(--vscode-widget-border, #3c3c3c);
	border-radius: 6px;
	padding: 16px;
	background: var(--vscode-editor-background);
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.field { margin-bottom: 10px; }
.field label { display: block; margin-bottom: 4px; color: var(--vscode-settings-labelForeground, inherit); }
.field input[type="text"],
.field input[type="password"],
.field input[type="number"],
.field select {
	width: 100%;
	padding: 4px 8px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, #3c3c3c);
	border-radius: 2px;
	font-size: var(--vscode-font-size);
}
.field input:focus, .field select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.field .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 3px; }
.field-row { display: flex; gap: 10px; }
.field-row .field { flex: 1; }
.preset-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.preset-row button {
	background: transparent;
	color: var(--vscode-textLink-foreground);
	border: 1px solid var(--vscode-widget-border, #3c3c3c);
	border-radius: 10px;
	padding: 2px 10px;
	font-size: 0.85em;
}
.preset-row button:hover { border-color: var(--vscode-textLink-foreground); background: transparent; }
.checkbox-row { display: flex; gap: 16px; align-items: center; }
.checkbox-row label { display: flex; align-items: center; gap: 5px; margin: 0; }
details { margin: 4px 0 10px; }
details summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
.form-actions { display: flex; gap: 8px; margin-top: 4px; }
.form-actions .grow { flex: 1; }
.key-status { margin-top: 6px; font-size: 0.9em; }
.key-status .badge { margin-right: 8px; }
`.trim();
}
