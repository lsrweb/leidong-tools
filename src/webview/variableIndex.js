(function(){
    const vscode = acquireVsCodeApi();
    let allVariables = [];
    let filteredVariables = [];
    let currentCategory = 'all';
    let fileName = '';
    const searchInput = document.getElementById('searchInput');
    const refreshBtn = document.getElementById('refreshBtn');
    const stats = document.getElementById('stats');
    const categoryBtns = document.querySelectorAll('.category-btn');
    const scrollContainer = document.getElementById('scrollContainer');
    const scrollContent = document.getElementById('scrollContent');
    const emptyState = document.getElementById('emptyState');
    const pinnedSection = document.getElementById('pinnedSection');
    const pinnedList = document.getElementById('pinnedList');
    const clearPins = document.getElementById('clearPins');

    // 虚拟滚动参数
    const ITEM_HEIGHT = 36;
    let visibleStart = 0;
    let visibleEnd = 0;
    let visibleCount = 0;
    let itemPool = []; // ✅ DOM 节点池，复用节点
    let poolSize = 0;

    const savedState = vscode.getState();
    let pinnedMap = new Map();
    if (savedState && Array.isArray(savedState.pinnedItems)) {
        savedState.pinnedItems.forEach(item => {
            if (item && item.key) {
                pinnedMap.set(item.key, item);
            }
        });
    }

    function getPinKey(variable) {
        return `${variable.uri}|${variable.type}|${variable.name}|${variable.line}`;
    }

    function persistPins() {
        vscode.setState({ pinnedItems: Array.from(pinnedMap.values()) });
    }

    function jumpTo(variable) {
        vscode.postMessage({ type: 'jump', data: { uri: variable.uri, line: variable.line } });
    }

    function getFileName(uri) {
        const parts = uri.split(/[\\/]/);
        return parts[parts.length - 1] || uri;
    }

    function updateStats() {
        stats.textContent = `${filteredVariables.length} / ${allVariables.length} 变量  |  Pin: ${pinnedMap.size}  |  文件: ${fileName}`;
    }

    function filterVariables() {
        const keyword = searchInput.value.trim().toLowerCase();
        filteredVariables = allVariables.filter(function(v){
            if (currentCategory !== 'all' && v.type !== currentCategory) { return false; }
            if (!keyword) { return true; }
            return v.name.toLowerCase().includes(keyword);
        });
        updateStats();
        renderPinnedList();
        renderVirtualList();
    }

    function renderPinnedList() {
        const pins = Array.from(pinnedMap.values()).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
        if (pins.length === 0) {
            pinnedSection.style.display = 'none';
            pinnedList.innerHTML = '';
            return;
        }

        pinnedSection.style.display = 'block';
        pinnedList.innerHTML = '';
        pins.forEach(pin => {
            const item = document.createElement('div');
            item.className = 'pinned-item';
            item.innerHTML = `
                <span class="pinned-name" title="${pin.name}">${pin.name}</span>
                <span class="variable-type">${pin.type}</span>
                <span class="variable-line">:${pin.line}</span>
                <span class="pinned-file">${pin.fileName || getFileName(pin.uri)}</span>
                <button class="pin-btn pinned" title="Unpin">-</button>
            `;
            const pinBtn = item.querySelector('.pin-btn');
            pinBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                togglePin(pin);
            });
            item.addEventListener('click', () => jumpTo(pin));
            pinnedList.appendChild(item);
        });
    }

    function togglePin(variable) {
        const key = getPinKey(variable);
        if (pinnedMap.has(key)) {
            pinnedMap.delete(key);
        } else {
            pinnedMap.set(key, {
                ...variable,
                key,
                pinnedAt: Date.now(),
                fileName: getFileName(variable.uri)
            });
        }
        persistPins();
        renderPinnedList();
        updateStats();
        renderVirtualList();
    }

    // ✅ 创建或复用 DOM 节点
    function getItemNode(index) {
        if (index < itemPool.length) {
            return itemPool[index];
        }
        const item = document.createElement('div');
        item.className = 'variable-item';
        item.style.position = 'absolute';
        // ✅ 不设置 width，让 CSS 控制（避免覆盖导致样式崩溃）
        scrollContent.appendChild(item);
        itemPool.push(item);
        return item;
    }

    // ✅ 更新节点内容和位置
    function updateItem(node, variable, position) {
        const pinKey = getPinKey(variable);
        const isPinned = pinnedMap.has(pinKey);
        node.style.top = `${position * ITEM_HEIGHT}px`;
        node.style.display = 'flex';
        node.innerHTML = `
            <span class="variable-name" title="${variable.name}">${variable.name}</span>
            <span class="variable-type">${variable.type}</span>
            <span class="variable-line">:${variable.line}</span>
            <button class="pin-btn ${isPinned ? 'pinned' : ''}" title="${isPinned ? 'Unpin' : 'Pin'}">${isPinned ? '-' : '+'}</button>
        `;
        const pinBtn = node.querySelector('.pin-btn');
        pinBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            togglePin(variable);
        });
        node.onclick = () => {
            jumpTo(variable);
        };
    }

    function renderVirtualList() {
        const total = filteredVariables.length;
        const containerHeight = scrollContainer.clientHeight;
        const scrollTop = scrollContainer.scrollTop;
        
        visibleCount = Math.ceil(containerHeight / ITEM_HEIGHT) + 5;
        visibleStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 2);
        visibleEnd = Math.min(total, visibleStart + visibleCount);

        scrollContent.style.height = `${total * ITEM_HEIGHT}px`;

        if (total === 0) {
            emptyState.style.display = 'block';
            // 隐藏所有节点
            for (let i = 0; i < itemPool.length; i++) {
                itemPool[i].style.display = 'none';
            }
            return;
        } else {
            emptyState.style.display = 'none';
        }

        // ✅ 确保节点池足够大
        const neededNodes = visibleEnd - visibleStart;
        while (itemPool.length < neededNodes) {
            getItemNode(itemPool.length);
        }

        // ✅ 更新可见范围内的节点
        let poolIndex = 0;
        for (let i = visibleStart; i < visibleEnd; i++) {
            const node = itemPool[poolIndex];
            updateItem(node, filteredVariables[i], i);
            poolIndex++;
        }

        // ✅ 隐藏多余的节点（不删除，只隐藏）
        for (let i = poolIndex; i < itemPool.length; i++) {
            itemPool[i].style.display = 'none';
        }
    }

    // ✅ 使用 requestAnimationFrame 优化滚动
    let rafId = null;
    function handleScroll() {
        if (rafId) {
            return;
        }
        rafId = requestAnimationFrame(function() {
            renderVirtualList();
            rafId = null;
        });
    }

    // 事件绑定
    searchInput.addEventListener('input', filterVariables);
    refreshBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
    });
    clearPins.addEventListener('click', () => {
        pinnedMap.clear();
        persistPins();
        renderPinnedList();
        updateStats();
        renderVirtualList();
    });
    categoryBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            categoryBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategory = btn.dataset.type;
            filterVariables();
        });
    });
    scrollContainer.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', renderVirtualList);

    // 接收扩展消息
    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'update') {
            allVariables = msg.data.variables || [];
            fileName = msg.data.fileName || '';
            searchInput.value = '';
            currentCategory = 'all';
            categoryBtns.forEach(b => b.classList.remove('active'));
            categoryBtns[0].classList.add('active');
            filterVariables();
        }
    });

    // 首次渲染
    renderPinnedList();
    renderVirtualList();
})();
