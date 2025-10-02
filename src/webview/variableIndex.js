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

    function renderVirtualList() {
        const total = filteredVariables.length;
        const containerHeight = scrollContainer.clientHeight;
        visibleCount = Math.ceil(containerHeight / ITEM_HEIGHT) + 2;
        const scrollTop = scrollContainer.scrollTop;
        visibleStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT));
        visibleEnd = Math.min(total, visibleStart + visibleCount);

        scrollContent.style.height = `${total * ITEM_HEIGHT}px`;
        scrollContent.innerHTML = '';

        if (total === 0) {
            emptyState.style.display = 'block';
            return;
        } else {
            emptyState.style.display = 'none';
        }

        for (let i = visibleStart; i < visibleEnd; i++) {
            const v = filteredVariables[i];
            const item = document.createElement('div');
            item.className = 'variable-item';
            item.style.position = 'absolute';
            item.style.top = `${i * ITEM_HEIGHT}px`;
            item.innerHTML = `
                <span class="variable-name" title="${v.name}">${v.name}</span>
                <span class="variable-type">${v.type}</span>
                <span class="variable-line">:${v.line}</span>
            `;
            item.onclick = () => {
                vscode.postMessage({ type: 'jump', data: { uri: v.uri, line: v.line } });
            };
            scrollContent.appendChild(item);
        }
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
    scrollContainer.addEventListener('scroll', renderVirtualList);
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
