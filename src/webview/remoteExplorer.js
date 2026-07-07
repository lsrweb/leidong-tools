(function () {
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('remote-root');
    const empty = document.getElementById('remote-empty');
    const pending = new Map();
    let sequence = 0;
    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu'; contextMenu.hidden = true; document.body.append(contextMenu);

    function showUploadMenu(event, node) {
        if (node.kind === 'file') { return; }
        event.preventDefault(); event.stopPropagation(); contextMenu.textContent = '';
        for (const [label, action] of [['上传文件', 'uploadFile'], ['上传文件夹', 'uploadFolder']]) {
            const item = document.createElement('button'); item.textContent = label;
            item.onclick = () => { contextMenu.hidden = true; vscode.postMessage({ type: 'action', action, node }); };
            contextMenu.append(item);
        }
        contextMenu.style.left = `${event.clientX}px`; contextMenu.style.top = `${event.clientY}px`; contextMenu.hidden = false;
    }

    function request(type, data) {
        const requestId = String(++sequence);
        vscode.postMessage({ type, requestId, ...data });
        return new Promise(resolve => pending.set(requestId, resolve));
    }

    function button(icon, title, action) {
        const el = document.createElement('button');
        el.className = 'row-action'; el.textContent = icon; el.title = title;
        el.onclick = event => { event.stopPropagation(); action(); };
        return el;
    }

    function createNode(node, depth) {
        const wrapper = document.createElement('div');
        const row = document.createElement('div');
        const children = document.createElement('div');
        row.className = `remote-row ${node.kind}`;
        row.style.setProperty('--depth', String(depth));
        row.innerHTML = `<span class="chevron">${node.kind === 'file' ? '' : '›'}</span><span class="kind">${node.kind === 'profile' ? '◉' : node.kind === 'directory' ? '▰' : '·'}</span><span class="label"></span><span class="meta"></span>`;
        row.querySelector('.label').textContent = node.label;
        row.querySelector('.meta').textContent = node.meta || '';
        const actions = document.createElement('span'); actions.className = 'actions';
        if (node.kind === 'file') { actions.append(button('↓', '下载', () => vscode.postMessage({ type: 'action', action: 'download', node }))); }
        if (node.kind !== 'file') { actions.append(button('↑', '上传文件', () => vscode.postMessage({ type: 'action', action: 'uploadFile', node }))); }
        row.append(actions);
        row.oncontextmenu = event => showUploadMenu(event, node);
        let loaded = false;
        row.onclick = async () => {
            if (node.kind === 'file') { vscode.postMessage({ type: 'action', action: 'preview', node }); return; }
            const open = wrapper.classList.toggle('open');
            if (!open || loaded) { return; }
            row.classList.add('loading');
            const result = await request('list', { profileId: node.profileId, remotePath: node.remotePath });
            row.classList.remove('loading'); loaded = true;
            for (const child of result || []) { children.append(createNode(child, depth + 1)); }
        };
        wrapper.append(row, children);
        return wrapper;
    }

    function render(profiles) {
        root.textContent = '';
        empty.hidden = profiles.length > 0;
        for (const profile of profiles) { root.append(createNode(profile, 0)); }
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'profiles') { render(message.items || []); }
        if (message.type === 'response' && pending.has(message.requestId)) {
            pending.get(message.requestId)(message.items || []); pending.delete(message.requestId);
        }
    });
    document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
    document.getElementById('config').onclick = () => vscode.postMessage({ type: 'command', command: 'leidong-tools.sftp.openConfig' });
    document.getElementById('logs').onclick = () => vscode.postMessage({ type: 'command', command: 'leidong-tools.sftp.showLogs' });
    window.addEventListener('click', () => { contextMenu.hidden = true; });
    window.addEventListener('blur', () => { contextMenu.hidden = true; });
    vscode.postMessage({ type: 'ready' });
})();
