(function () {
    function create(element, options) {
        const margin = options?.margin ?? 8;
        let point;

        function position() {
            if (!point || element.hidden) { return; }
            element.style.maxHeight = '';
            element.style.visibility = 'hidden';
            const rect = element.getBoundingClientRect();
            const below = window.innerHeight - point.y - margin;
            const above = point.y - margin;
            const openAbove = rect.height > below && above > below;
            const available = Math.max(80, openAbove ? above : below);
            const left = Math.max(margin, Math.min(point.x, window.innerWidth - rect.width - margin));
            const top = openAbove
                ? Math.max(margin, point.y - Math.min(rect.height, available))
                : Math.max(margin, point.y);
            element.style.left = `${left}px`;
            element.style.top = `${top}px`;
            element.style.maxHeight = `${available}px`;
            element.style.visibility = 'visible';
        }

        function show(x, y) {
            point = { x, y };
            element.hidden = false;
            requestAnimationFrame(position);
        }

        function hide() {
            point = undefined;
            element.hidden = true;
            element.style.visibility = '';
        }

        window.addEventListener('resize', position);
        window.addEventListener('scroll', position, true);
        window.addEventListener('blur', hide);
        window.addEventListener('keydown', event => { if (event.key === 'Escape') { hide(); } });
        window.addEventListener('pointerdown', event => {
            if (!element.hidden && !element.contains(event.target)) { hide(); }
        });

        return { show, hide, position };
    }

    window.RemotePopover = { create };
})();
