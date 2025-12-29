(function() {
    const vscode = acquireVsCodeApi();
    const refreshBtn = document.getElementById('refreshBtn');
    const lastUpdated = document.getElementById('lastUpdated');

    const fields = {
        vueIndexSize: document.getElementById('vueIndexSize'),
        vueIndexBuilt: document.getElementById('vueIndexBuilt'),
        vueIndexExternal: document.getElementById('vueIndexExternal'),
        vueIndexExternalSize: document.getElementById('vueIndexExternalSize'),
        templateIndexSize: document.getElementById('templateIndexSize'),
        templateIndexBuilt: document.getElementById('templateIndexBuilt'),
        documentParseSize: document.getElementById('documentParseSize'),
        documentParseMax: document.getElementById('documentParseMax'),
        documentParseAccess: document.getElementById('documentParseAccess'),
        documentParseAvg: document.getElementById('documentParseAvg')
    };

    function formatTime(value) {
        if (!value) {
            return '--';
        }
        const date = new Date(value);
        return date.toLocaleString();
    }

    function formatNumber(value) {
        if (typeof value !== 'number') {
            return '--';
        }
        return value.toLocaleString();
    }

    function update(data) {
        lastUpdated.textContent = `Last update: ${formatTime(data.updatedAt)}`;

        fields.vueIndexSize.textContent = formatNumber(data.vueIndex.size);
        fields.vueIndexBuilt.textContent = formatTime(data.vueIndex.lastBuiltAt);
        fields.vueIndexExternal.textContent = formatTime(data.vueIndex.lastExternalBuiltAt);
        fields.vueIndexExternalSize.textContent = formatNumber(data.vueIndex.externalCacheSize);

        fields.templateIndexSize.textContent = formatNumber(data.templateIndex.size);
        fields.templateIndexBuilt.textContent = formatTime(data.templateIndex.lastBuiltAt);

        fields.documentParseSize.textContent = formatNumber(data.documentParse.size);
        fields.documentParseMax.textContent = formatNumber(data.documentParse.maxSize);
        fields.documentParseAccess.textContent = formatNumber(data.documentParse.totalAccesses);
        fields.documentParseAvg.textContent = formatNumber(data.documentParse.averageAccessCount);
    }

    refreshBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'update') {
            update(msg.data);
        }
    });
})();
