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

    // 虚拟滚动参数
    const ITEM_HEIGHT = 32;
    let visibleStart = 0;
    let visibleEnd = 0;
    let visibleCount = 0;
    let itemPool = []; // ✅ DOM 节点池，复用节点
    let poolSize = 0;

    function updateStats() {
        stats.textContent = `${filteredVariables.length} / ${allVariables.length} 变量  |  文件: ${fileName}`;
    }

    function filterVariables() {
        const keyword = searchInput.value.trim().toLowerCase();
        filteredVariables = allVariables.filter(function(v){
            if (currentCategory !== 'all' && v.type !== currentCategory) { return false; }
            if (!keyword) { return true; }
            return v.name.toLowerCase().includes(keyword);
        });
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
        node.style.top = `${position * ITEM_HEIGHT}px`;
        node.style.display = 'flex';
        node.innerHTML = `
            <span class="variable-name" title="${variable.name}">${variable.name}</span>
            <span class="variable-type">${variable.type}</span>
            <span class="variable-line">:${variable.line}</span>
        `;
        node.onclick = () => {
            vscode.postMessage({ type: 'jump', data: { uri: variable.uri, line: variable.line } });
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
    renderVirtualList();
})();
