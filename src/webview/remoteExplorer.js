(function () {
    const vscode = acquireVsCodeApi();
    const viewport = document.getElementById('remote-viewport');
    const spacer = document.getElementById('remote-spacer');
    const root = document.getElementById('remote-root');
    const empty = document.getElementById('remote-empty');
    const ROW_HEIGHT = 26;
    const OVERSCAN = 12;
    const nodes = new Map();
    const pending = new Map();
    const requestsByKey = new Map();
    const initialState = vscode.getState() || {};
    const expanded = new Set(initialState.expanded || []);
    let roots = [];
    let flat = [];
    let selected = initialState.selected || '';
    let sequence = 0;
    let initialized = false;

    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.hidden = true;
    contextMenu.setAttribute('role', 'menu');
    document.body.append(contextMenu);
    const popover = window.RemotePopover.create(contextMenu, { margin: 8 });

    function nodeKey(node) {
        return node.nodeId || `${node.profileId || ''}|${node.remotePath || ''}`;
    }

    function messageNode(node) {
        return {
            nodeId: node.nodeId,
            profileId: node.profileId,
            remotePath: node.remotePath,
            kind: node.kind,
            label: node.label,
            workspaceUri: node.workspaceUri,
            autoUploadActive: node.autoUploadActive,
            autoUploadSelected: node.autoUploadSelected,
            profileUploadOnSave: node.profileUploadOnSave,
        };
    }

    function persist() {
        vscode.setState({ expanded: [...expanded], selected, scrollTop: viewport.scrollTop });
    }

    function request(type, data, dedupeKey) {
        if (dedupeKey && requestsByKey.has(dedupeKey)) { return requestsByKey.get(dedupeKey); }
        const requestId = String(++sequence);
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('远程请求超时')); }, 20000);
            pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
            vscode.postMessage({ type, requestId, ...data });
        }).finally(() => { if (dedupeKey) { requestsByKey.delete(dedupeKey); } });
        if (dedupeKey) { requestsByKey.set(dedupeKey, promise); }
        return promise;
    }

    function updateNode(target, source) {
        for (const [key, value] of Object.entries(source)) {
            if (!['children', 'parent', 'key', 'loaded', 'loading'].includes(key)) { target[key] = value; }
        }
    }

    function registerNode(node, parent) {
        node.parent = parent;
        node.key = nodeKey(node);
        node.children = node.children || [];
        nodes.set(node.key, node);
        for (const child of node.children) { registerNode(child, node); }
        return node;
    }

    function forgetTree(node) {
        expanded.delete(node.key);
        nodes.delete(node.key);
        for (const child of node.children || []) { forgetTree(child); }
    }

    function mergeChildren(parent, incomingChildren, reset) {
        const previous = new Map((parent.children || []).map(child => [child.key, child]));
        const next = [];
        for (const incoming of incomingChildren || []) {
            const key = nodeKey(incoming);
            const existing = previous.get(key);
            if (existing) {
                previous.delete(key);
                updateNode(existing, incoming);
                existing.parent = parent;
                if (incoming.children) { mergeChildren(existing, incoming.children, reset); }
                if (reset && existing.kind === 'profile') { existing.children = []; existing.loaded = false; }
                next.push(existing);
            } else {
                next.push(registerNode(incoming, parent));
            }
        }
        for (const removed of previous.values()) { forgetTree(removed); }
        parent.children = next;
    }

    function reindexNodes() {
        nodes.clear();
        for (const node of roots) { registerNode(node); }
    }

    function captureAnchor() {
        if (!flat.length) { return { keys: [], offset: 0 }; }
        const index = Math.max(0, Math.min(flat.length - 1, Math.floor(viewport.scrollTop / ROW_HEIGHT)));
        const entry = flat[index];
        const keys = [entry.node.key];
        if (flat[index + 1]) { keys.push(flat[index + 1].node.key); }
        if (flat[index - 1]) { keys.push(flat[index - 1].node.key); }
        if (entry.node.parent) { keys.push(entry.node.parent.key); }
        return { keys, offset: viewport.scrollTop - index * ROW_HEIGHT };
    }

    function remapAnchor(anchor, oldPath, newPath, profileId) {
        if (!oldPath || !newPath) { return; }
        const prefix = `${profileId}|${oldPath}`;
        anchor.keys = anchor.keys.map(key => key === prefix || key.startsWith(`${prefix}/`)
            ? `${profileId}|${newPath}${key.slice(prefix.length)}`
            : key);
    }

    function restoreAnchor(anchor) {
        const key = anchor.keys.find(candidate => flat.some(entry => entry.node.key === candidate));
        if (!key) { return; }
        const index = flat.findIndex(entry => entry.node.key === key);
        viewport.scrollTop = Math.max(0, index * ROW_HEIGHT + anchor.offset);
        renderVisible();
        persist();
    }

    function rebuildFlat(anchor) {
        flat = [];
        const visit = (node, depth) => {
            flat.push({ node, depth });
            if (expanded.has(node.key)) { for (const child of node.children || []) { visit(child, depth + 1); } }
        };
        for (const node of roots) { visit(node, 0); }
        spacer.style.height = `${flat.length * ROW_HEIGHT}px`;
        if (selected && !nodes.has(selected)) { selected = anchor?.keys.find(key => nodes.has(key)) || ''; }
        renderVisible();
        if (anchor) { restoreAnchor(anchor); } else { persist(); }
    }

    async function loadNode(node) {
        const items = await request('list', { profileId: node.profileId, remotePath: node.remotePath }, node.key);
        mergeChildren(node, items, false);
        node.loaded = true;
    }

    async function toggle(node, action = 'preview') {
        if (node.kind === 'file') {
            vscode.postMessage({ type: 'action', action, node: messageNode(node) });
            return;
        }
        if (expanded.has(node.key)) { expanded.delete(node.key); rebuildFlat(); return; }
        expanded.add(node.key);
        if (node.kind !== 'workspace' && !node.loaded) {
            node.loading = true; renderVisible();
            try { await loadNode(node); }
            catch (error) {
                vscode.postMessage({ type: 'clientError', message: error.message });
                expanded.delete(node.key);
            } finally { node.loading = false; }
        }
        rebuildFlat();
    }

    function actionsFor(node) {
        if (node.kind === 'workspace') { return [['切换保存自动上传', 'toggleWorkspaceUpload'], ['打开配置', 'config']]; }
        if (node.kind === 'profile') { return [['测试连接', 'test'], ['刷新', 'refreshNode'], ['断开连接', 'disconnect'], ['上传文件', 'uploadFile'], ['上传文件夹', 'uploadFolder'], ['下载根目录', 'download'], [node.autoUploadSelected ? '关闭此连接自动上传' : '开启此连接自动上传', 'toggleProfileAuto'], ['管理自动上传目标', 'selectAuto'], ['打开配置', 'config'], ['复制远程路径', 'copyPath']]; }
        if (node.kind === 'directory') { return [['刷新目录', 'refreshNode'], ['新建目录', 'createDirectory'], ['上传文件', 'uploadFile'], ['上传文件夹', 'uploadFolder'], ['下载目录', 'download'], ['重命名', 'rename'], ['删除目录', 'delete'], ['复制远程路径', 'copyPath']]; }
        return [['打开编辑', 'open'], ['预览', 'preview'], ['下载', 'download'], ['上传覆盖', 'uploadOverwrite'], ['备份并上传', 'backupUpload'], ['重命名', 'rename'], ['删除', 'delete'], ['复制远程路径', 'copyPath']];
    }

    function invoke(action, node) {
        popover.hide();
        if (action === 'toggleWorkspaceUpload') { vscode.postMessage({ type: 'toggleWorkspaceUpload', workspaceUri: node.workspaceUri }); return; }
        if (action === 'config') { vscode.postMessage({ type: 'openConfig', workspaceUri: node.workspaceUri }); return; }
        vscode.postMessage({ type: 'action', action, node: messageNode(node) });
    }

    function showMenu(event, node) {
        event.preventDefault();
        event.stopPropagation();
        contextMenu.textContent = '';
        for (const [label, action] of actionsFor(node)) {
            const item = document.createElement('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitem');
            item.textContent = label;
            item.onclick = () => invoke(action, node);
            contextMenu.append(item);
        }
        popover.show(event.clientX, event.clientY);
    }

    function createRow(entry, index) {
        const { node, depth } = entry;
        const row = document.createElement('div');
        row.className = `remote-row ${node.kind}${selected === node.key ? ' selected' : ''}`;
        row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
        row.style.setProperty('--depth', String(depth));
        const expandable = node.kind !== 'file';
        const chevron = node.loading ? 'loading codicon-modifier-spin' : expanded.has(node.key) ? 'chevron-down' : 'chevron-right';
        const kindIcon = node.kind === 'workspace' ? 'root-folder' : node.kind === 'profile' ? 'remote-explorer' : node.kind === 'directory' ? 'folder' : 'file';
        row.innerHTML = `<span class="chevron">${expandable ? `<i class="codicon codicon-${chevron}"></i>` : ''}</span><span class="kind"><i class="codicon codicon-${kindIcon}"></i></span><span class="label"></span><span class="meta"></span>`;
        row.querySelector('.label').textContent = node.label;
        row.querySelector('.meta').textContent = node.meta || (node.uploadOnSaveEnabled === false ? '自动上传关' : '');
        row.onclick = () => { selected = node.key; void toggle(node, 'preview'); };
        row.ondblclick = event => { if (node.kind === 'file') { event.preventDefault(); void toggle(node, 'open'); } };
        row.oncontextmenu = event => showMenu(event, node);
        return row;
    }

    function renderVisible() {
        const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
        const count = Math.ceil(viewport.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
        const end = Math.min(flat.length, start + count);
        root.textContent = '';
        for (let index = start; index < end; index++) { root.append(createRow(flat[index], index)); }
    }

    async function restoreExpanded(node) {
        if (!expanded.has(node.key)) { return; }
        if (node.kind !== 'workspace' && !node.loaded) {
            try { await loadNode(node); }
            catch { expanded.delete(node.key); return; }
        }
        for (const child of node.children || []) { await restoreExpanded(child); }
    }

    function migratePath(profileId, oldPath, newPath) {
        const oldKey = `${profileId}|${oldPath}`;
        const node = nodes.get(oldKey);
        if (!node) { return; }
        const migrate = current => {
            const previousKey = current.key;
            current.remotePath = `${newPath}${current.remotePath.slice(oldPath.length)}`;
            current.key = nodeKey(current);
            if (expanded.delete(previousKey)) { expanded.add(current.key); }
            if (selected === previousKey) { selected = current.key; }
            for (const child of current.children || []) { migrate(child); }
        };
        migrate(node);
        reindexNodes();
    }

    async function refreshDirectory(message) {
        const key = `${message.profileId}|${message.remotePath}`;
        const directory = nodes.get(key);
        if (!directory || !directory.loaded) { return; }
        const anchor = captureAnchor();
        remapAnchor(anchor, message.oldPath, message.newPath, message.profileId);
        if (message.oldPath && message.newPath) { migratePath(message.profileId, message.oldPath, message.newPath); }
        directory.loading = true;
        renderVisible();
        try {
            const items = await request('list', { profileId: message.profileId, remotePath: message.remotePath, force: true }, `${key}:refresh`);
            mergeChildren(directory, items, false);
            directory.loaded = true;
            reindexNodes();
            rebuildFlat(anchor);
        } catch (error) {
            vscode.postMessage({ type: 'clientError', message: error.message });
        } finally {
            directory.loading = false;
            renderVisible();
        }
    }

    async function loadProfiles(items, resetDirectories) {
        const anchor = initialized ? captureAnchor() : undefined;
        const shell = { children: roots };
        mergeChildren(shell, items, resetDirectories);
        roots = shell.children;
        reindexNodes();
        empty.hidden = roots.length > 0;
        rebuildFlat();
        for (const node of roots) { await restoreExpanded(node); }
        reindexNodes();
        rebuildFlat(anchor);
        if (!initialized) {
            initialized = true;
            requestAnimationFrame(() => {
                viewport.scrollTop = initialState.scrollTop || 0;
                renderVisible();
                persist();
            });
        }
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'profiles') { void loadProfiles(message.items || [], message.resetDirectories === true); }
        if (message.type === 'response' && pending.has(message.requestId)) { pending.get(message.requestId)(message.items || []); pending.delete(message.requestId); }
        if (message.type === 'directoryChanged') { void refreshDirectory(message); }
        if (message.type === 'fileChanged') {
            const node = nodes.get(`${message.profileId}|${message.remotePath}`);
            if (node) {
                const anchor = captureAnchor();
                node.meta = message.meta || node.meta;
                rebuildFlat(anchor);
            }
        }
    });
    viewport.addEventListener('scroll', () => { renderVisible(); persist(); }, { passive: true });
    window.addEventListener('resize', renderVisible);
    document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
    document.getElementById('config').onclick = () => vscode.postMessage({ type: 'command', command: 'leidong-tools.sftp.openConfig' });
    document.getElementById('logs').onclick = () => vscode.postMessage({ type: 'command', command: 'leidong-tools.sftp.showLogs' });
    document.getElementById('auto-upload').onclick = () => vscode.postMessage({ type: 'command', command: 'leidong-tools.sftp.toggleUploadOnSave' });
    vscode.postMessage({ type: 'ready' });
})();
