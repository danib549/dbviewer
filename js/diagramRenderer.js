/**
 * Diagram Renderer Module
 * Renders table nodes on canvas with SVG relationship lines
 * Supports drag, pan, zoom, hover highlight, focus mode, filtering
 * Layout options: radial (hub-center), grid, force-directed
 */
const DiagramRenderer = (() => {

    const COLORS = [
        '#6c63ff', '#f0b429', '#22c55e', '#ef4444', '#4da6ff',
        '#a78bfa', '#f472b6', '#fb923c', '#38bdf8', '#34d399',
        '#e879f9', '#fbbf24', '#f87171', '#60a5fa', '#a3e635',
        '#c084fc', '#fb7c86', '#2dd4bf'
    ];

    let canvas, svgLayer, container;
    let tables = [];
    let relationships = [];
    let positions = {};
    let scale = 1;
    let panX = 0, panY = 0;
    let isPanning = false;
    let panStartX, panStartY;
    let dragNode = null;
    let dragOffsetX, dragOffsetY;
    let onTableClick = null;
    let focusedTable = null;
    let hiddenTypes = new Set();
    let currentLayout = 'radial'; // 'radial' | 'grid' | 'force'
    let wasDragged = false;

    function init(onTableClickCb) {
        canvas = document.getElementById('canvas');
        svgLayer = document.getElementById('svg-lines');
        container = document.getElementById('canvas-container');
        onTableClick = onTableClickCb;

        container.addEventListener('mousedown', onPanStart);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        container.addEventListener('wheel', onWheel, { passive: false });
        container.addEventListener('touchstart', onTouchStart, { passive: false });
        container.addEventListener('touchmove', onTouchMove, { passive: false });
        container.addEventListener('touchend', onTouchEnd);

        document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(scale + 0.1));
        document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(scale - 0.1));
        document.getElementById('btn-zoom-fit').addEventListener('click', fitToScreen);

        // Layout buttons
        document.getElementById('btn-layout-radial').addEventListener('click', () => switchLayout('radial'));
        document.getElementById('btn-layout-grid').addEventListener('click', () => switchLayout('grid'));
        document.getElementById('btn-layout-force').addEventListener('click', () => switchLayout('force'));

        window.addEventListener('resize', () => drawAllLines());

        container.addEventListener('click', (e) => {
            if (!e.target.closest('.table-node')) clearFocus();
        });
    }

    // =================== LAYOUT ALGORITHMS ===================

    function switchLayout(layoutName) {
        currentLayout = layoutName;

        // Update button states
        document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('btn-layout-' + layoutName).classList.add('active');

        // Recalculate positions
        positions = {};
        calculateLayout();

        // Re-render nodes at new positions
        canvas.querySelectorAll('.table-node').forEach(n => {
            const tName = n.dataset.table;
            if (positions[tName]) {
                n.style.left = positions[tName].x + 'px';
                n.style.top = positions[tName].y + 'px';
            }
        });

        // Redraw lines + fit
        requestAnimationFrame(() => {
            drawAllLines();
            setTimeout(() => fitToScreen(), 50);
        });
    }

    function calculateLayout() {
        if (Object.keys(positions).length === tables.length) return;

        switch (currentLayout) {
            case 'radial': radialLayout(); break;
            case 'grid': gridLayout(); break;
            case 'force': forceLayout(); break;
            default: radialLayout();
        }
    }

    /**
     * Radial layout: hub table at center, BFS rings outward
     */
    function radialLayout() {
        if (tables.length === 0) return;

        // 1. Calculate connectivity scores
        const connCounts = {};
        tables.forEach(t => { connCounts[t.name] = 0; });
        relationships.forEach(r => {
            if (connCounts[r.fromTable] !== undefined) connCounts[r.fromTable]++;
            if (connCounts[r.toTable] !== undefined) connCounts[r.toTable]++;
        });

        // 2. Find hub (most connections)
        const sorted = [...tables].sort((a, b) => (connCounts[b.name] || 0) - (connCounts[a.name] || 0));
        const hub = sorted[0];

        // 3. BFS from hub to assign layers
        const layers = [];
        const visited = new Set();

        layers[0] = [hub];
        visited.add(hub.name);

        let currentLayer = 0;
        while (visited.size < tables.length) {
            currentLayer++;
            const nextLayer = [];

            for (const prevTable of (layers[currentLayer - 1] || [])) {
                relationships.forEach(r => {
                    let neighbor = null;
                    if (r.fromTable === prevTable.name && !visited.has(r.toTable)) {
                        neighbor = tables.find(t => t.name === r.toTable);
                    }
                    if (r.toTable === prevTable.name && !visited.has(r.fromTable)) {
                        neighbor = tables.find(t => t.name === r.fromTable);
                    }
                    if (neighbor && !visited.has(neighbor.name)) {
                        nextLayer.push(neighbor);
                        visited.add(neighbor.name);
                    }
                });
            }

            // If no new neighbors found but unvisited tables remain, add them
            if (nextLayer.length === 0) {
                for (const t of tables) {
                    if (!visited.has(t.name)) {
                        nextLayer.push(t);
                        visited.add(t.name);
                    }
                }
            }

            if (nextLayer.length > 0) {
                layers[currentLayer] = nextLayer;
            }
        }

        // 4. Position in concentric circles
        const centerX = 600;
        const centerY = 500;
        const ringSpacing = 280;

        for (let li = 0; li < layers.length; li++) {
            const layer = layers[li];
            if (!layer) continue;

            if (li === 0) {
                // Hub at center
                positions[layer[0].name] = { x: centerX, y: centerY };
                continue;
            }

            const radius = li * ringSpacing;
            const count = layer.length;

            // Sort layer tables so connected ones are adjacent
            const layerSorted = sortLayerByConnections(layer, layers[li - 1] || [], relationships);

            layerSorted.forEach((table, idx) => {
                const angle = (idx / count) * 2 * Math.PI - Math.PI / 2;
                positions[table.name] = {
                    x: centerX + radius * Math.cos(angle),
                    y: centerY + radius * Math.sin(angle),
                };
            });
        }
    }

    /**
     * Sort tables in a layer so that tables connected to the same parent are adjacent
     */
    function sortLayerByConnections(layer, prevLayer, rels) {
        if (prevLayer.length === 0) return layer;

        // For each table in this layer, find which parent it connects to
        const parentIdx = {};
        layer.forEach(t => {
            let bestParent = 0;
            rels.forEach(r => {
                const parent = prevLayer.findIndex(p =>
                    (r.fromTable === t.name && r.toTable === p.name) ||
                    (r.toTable === t.name && r.fromTable === p.name)
                );
                if (parent >= 0) bestParent = parent;
            });
            parentIdx[t.name] = bestParent;
        });

        return [...layer].sort((a, b) => parentIdx[a.name] - parentIdx[b.name]);
    }

    /**
     * Grid layout: sorted by connection count, in rows
     */
    function gridLayout() {
        const cols = Math.ceil(Math.sqrt(tables.length));
        const spacingX = 300;
        const startX = 60;
        const startY = 60;

        const connCounts = {};
        tables.forEach(t => { connCounts[t.name] = 0; });
        relationships.forEach(r => {
            if (connCounts[r.fromTable] !== undefined) connCounts[r.fromTable]++;
            if (connCounts[r.toTable] !== undefined) connCounts[r.toTable]++;
        });

        const sorted = [...tables].sort((a, b) => (connCounts[b.name] || 0) - (connCounts[a.name] || 0));
        const rowHeights = {};

        sorted.forEach((table, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const estimatedHeight = 40 + (table.columns.length * 26) + 12;

            if (!rowHeights[row]) rowHeights[row] = 0;

            let yOffset = startY;
            for (let r = 0; r < row; r++) {
                yOffset += (rowHeights[r] || 200) + 60;
            }

            positions[table.name] = { x: startX + col * spacingX, y: yOffset };
            rowHeights[row] = Math.max(rowHeights[row] || 0, estimatedHeight);
        });
    }

    /**
     * Force-directed layout: spring physics simulation
     */
    function forceLayout() {
        if (tables.length === 0) return;

        const iterations = 80;
        const springLength = 280;
        const springK = 0.05;
        const repulsionK = 8000;
        const damping = 0.85;
        const centerGravity = 0.01;

        // Initialize in a circle
        const cx = 600, cy = 500, initRadius = 300;
        const vel = {};

        tables.forEach((t, i) => {
            const angle = (i / tables.length) * 2 * Math.PI;
            positions[t.name] = {
                x: cx + initRadius * Math.cos(angle),
                y: cy + initRadius * Math.sin(angle),
            };
            vel[t.name] = { x: 0, y: 0 };
        });

        for (let iter = 0; iter < iterations; iter++) {
            const forces = {};
            tables.forEach(t => { forces[t.name] = { x: 0, y: 0 }; });

            // Repulsion (all pairs)
            for (let i = 0; i < tables.length; i++) {
                for (let j = i + 1; j < tables.length; j++) {
                    const a = tables[i].name, b = tables[j].name;
                    const dx = positions[b].x - positions[a].x;
                    const dy = positions[b].y - positions[a].y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const f = repulsionK / (dist * dist);
                    const fx = (dx / dist) * f;
                    const fy = (dy / dist) * f;

                    forces[a].x -= fx; forces[a].y -= fy;
                    forces[b].x += fx; forces[b].y += fy;
                }
            }

            // Attraction (connected pairs)
            relationships.forEach(r => {
                if (!positions[r.fromTable] || !positions[r.toTable]) return;
                const dx = positions[r.toTable].x - positions[r.fromTable].x;
                const dy = positions[r.toTable].y - positions[r.fromTable].y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const f = springK * (dist - springLength);
                const fx = (dx / dist) * f;
                const fy = (dy / dist) * f;

                forces[r.fromTable].x += fx; forces[r.fromTable].y += fy;
                forces[r.toTable].x -= fx; forces[r.toTable].y -= fy;
            });

            // Center gravity
            tables.forEach(t => {
                forces[t.name].x += (cx - positions[t.name].x) * centerGravity;
                forces[t.name].y += (cy - positions[t.name].y) * centerGravity;
            });

            // Update
            tables.forEach(t => {
                vel[t.name].x = (vel[t.name].x + forces[t.name].x) * damping;
                vel[t.name].y = (vel[t.name].y + forces[t.name].y) * damping;
                positions[t.name].x += vel[t.name].x;
                positions[t.name].y += vel[t.name].y;
            });
        }
    }

    // =================== RENDERING ===================

    function render(tbls, rels) {
        tables = tbls;
        relationships = rels;

        canvas.querySelectorAll('.table-node').forEach(n => n.remove());
        calculateLayout();

        tables.forEach((table, i) => renderTableNode(table, i));

        requestAnimationFrame(() => {
            requestAnimationFrame(() => drawAllLines());
        });
        updateZoomLabel();
    }

    function renderTableNode(table, index) {
        const pos = positions[table.name];
        const colorIndex = index % COLORS.length;

        const node = document.createElement('div');
        node.className = `table-node table-color-${colorIndex}`;
        node.id = `tbl-${sanitizeId(table.name)}`;
        node.style.left = pos.x + 'px';
        node.style.top = pos.y + 'px';
        node.dataset.table = table.name;

        const header = document.createElement('div');
        header.className = 'table-node-header';
        header.innerHTML = `
            <span class="table-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <line x1="3" y1="9" x2="21" y2="9"/>
                    <line x1="9" y1="3" x2="9" y2="21"/>
                </svg>
            </span>
            <span class="table-name">${escapeHtml(table.name)}</span>
            <span class="table-row-count">${table.rowCount} rows</span>
        `;
        header.addEventListener('mousedown', (e) => onDragStart(e, node, table.name));
        header.addEventListener('touchstart', (e) => onTouchDragStart(e, node, table.name), { passive: false });
        header.addEventListener('click', (e) => {
            if (wasDragged) return;
            e.stopPropagation();
            setFocus(table.name);
        });
        node.appendChild(header);

        const colContainer = document.createElement('div');
        colContainer.className = 'table-node-columns';

        table.columns.forEach(col => {
            const row = document.createElement('div');
            let rowClass = 'table-col-row';
            if (col.isPK) rowClass += ' pk-row';
            if (col.isFK) rowClass += ' fk-row';
            row.className = rowClass;
            row.dataset.column = col.name;
            row.dataset.table = table.name;

            let iconClass = '', iconText = '';
            if (col.isPK) { iconClass = 'col-icon pk'; iconText = 'PK'; }
            else if (col.isFK) { iconClass = 'col-icon fk'; iconText = 'FK'; }

            row.innerHTML = `
                <span class="${iconClass}">${iconText}</span>
                <span class="col-name">${escapeHtml(col.name)}</span>
                <span class="col-type">${col.type}</span>
            `;
            row.addEventListener('dblclick', () => { if (onTableClick) onTableClick(table); });
            colContainer.appendChild(row);
        });

        node.appendChild(colContainer);
        node.addEventListener('dblclick', () => { if (onTableClick) onTableClick(table); });
        canvas.appendChild(node);
    }

    function sanitizeId(name) { return name.replace(/[^a-zA-Z0-9_-]/g, '_'); }
    function getNodeElement(tableName) { return document.getElementById(`tbl-${sanitizeId(tableName)}`); }

    // =================== FOCUS MODE ===================

    function setFocus(tableName) {
        if (focusedTable === tableName) { clearFocus(); return; }
        focusedTable = tableName;
        applyFocusDimming();
        drawAllLines();
    }

    function clearFocus() {
        if (!focusedTable) return;
        focusedTable = null;
        canvas.querySelectorAll('.table-node').forEach(n => {
            n.classList.remove('dimmed', 'focused');
        });
        drawAllLines();
    }

    function applyFocusDimming() {
        if (!focusedTable) return;
        const connected = new Set([focusedTable]);
        relationships.forEach(r => {
            if (r.fromTable === focusedTable) connected.add(r.toTable);
            if (r.toTable === focusedTable) connected.add(r.fromTable);
        });

        canvas.querySelectorAll('.table-node').forEach(n => {
            const t = n.dataset.table;
            if (t === focusedTable) { n.classList.add('focused'); n.classList.remove('dimmed'); }
            else if (connected.has(t)) { n.classList.remove('dimmed', 'focused'); }
            else { n.classList.add('dimmed'); n.classList.remove('focused'); }
        });
    }

    function setHiddenTypes(types) { hiddenTypes = new Set(types); drawAllLines(); }

    // =================== DRAG ===================

    function onDragStart(e, node, tableName) {
        if (e.button !== 0) return;
        e.stopPropagation();
        wasDragged = false;
        dragNode = { el: node, name: tableName };
        const rect = node.getBoundingClientRect();
        dragOffsetX = (e.clientX - rect.left) / scale;
        dragOffsetY = (e.clientY - rect.top) / scale;
        node.style.zIndex = 10;
        node.classList.add('highlighted');
    }

    function onTouchDragStart(e, node, tableName) {
        if (e.touches.length !== 1) return;
        e.preventDefault(); e.stopPropagation();
        wasDragged = false;
        const touch = e.touches[0];
        dragNode = { el: node, name: tableName };
        const rect = node.getBoundingClientRect();
        dragOffsetX = (touch.clientX - rect.left) / scale;
        dragOffsetY = (touch.clientY - rect.top) / scale;
        node.style.zIndex = 10;
        node.classList.add('highlighted');
    }

    // =================== PAN ===================

    function onPanStart(e) {
        if (dragNode || e.target.closest('.table-node')) return;
        isPanning = true;
        panStartX = e.clientX - panX;
        panStartY = e.clientY - panY;
        container.classList.add('grabbing');
    }

    function onMouseMove(e) {
        if (dragNode) {
            wasDragged = true;
            const r = container.getBoundingClientRect();
            const nx = (e.clientX - r.left - panX) / scale - dragOffsetX;
            const ny = (e.clientY - r.top - panY) / scale - dragOffsetY;
            dragNode.el.style.left = nx + 'px';
            dragNode.el.style.top = ny + 'px';
            positions[dragNode.name] = { x: nx, y: ny };
            drawAllLines();
        }
        if (isPanning) {
            panX = e.clientX - panStartX;
            panY = e.clientY - panStartY;
            applyTransform();
            drawAllLines();
        }
    }

    function onMouseUp() {
        if (dragNode) {
            dragNode.el.style.zIndex = '';
            dragNode.el.classList.remove('highlighted');
            dragNode = null;
        }
        if (isPanning) { isPanning = false; container.classList.remove('grabbing'); }
    }

    function onTouchStart(e) {
        if (e.target.closest('.table-node')) return;
        if (e.touches.length === 1) {
            isPanning = true;
            panStartX = e.touches[0].clientX - panX;
            panStartY = e.touches[0].clientY - panY;
        }
    }

    function onTouchMove(e) {
        if (dragNode && e.touches.length === 1) {
            e.preventDefault(); wasDragged = true;
            const t = e.touches[0], r = container.getBoundingClientRect();
            const nx = (t.clientX - r.left - panX) / scale - dragOffsetX;
            const ny = (t.clientY - r.top - panY) / scale - dragOffsetY;
            dragNode.el.style.left = nx + 'px';
            dragNode.el.style.top = ny + 'px';
            positions[dragNode.name] = { x: nx, y: ny };
            drawAllLines();
        }
        if (isPanning && e.touches.length === 1) {
            e.preventDefault();
            panX = e.touches[0].clientX - panStartX;
            panY = e.touches[0].clientY - panStartY;
            applyTransform();
            drawAllLines();
        }
    }

    function onTouchEnd() {
        if (dragNode) { dragNode.el.style.zIndex = ''; dragNode.el.classList.remove('highlighted'); dragNode = null; }
        isPanning = false;
    }

    // =================== ZOOM ===================

    function onWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.08 : 0.08;
        const ns = Math.max(0.2, Math.min(3, scale + delta));
        const r = container.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        panX = mx - (mx - panX) * (ns / scale);
        panY = my - (my - panY) * (ns / scale);
        scale = ns;
        applyTransform(); drawAllLines(); updateZoomLabel();
    }

    function setZoom(ns) {
        scale = Math.max(0.2, Math.min(3, ns));
        applyTransform(); drawAllLines(); updateZoomLabel();
    }

    function fitToScreen() {
        if (tables.length === 0) return;
        const cr = container.getBoundingClientRect();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        canvas.querySelectorAll('.table-node').forEach(n => {
            const x = parseFloat(n.style.left), y = parseFloat(n.style.top);
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + n.offsetWidth); maxY = Math.max(maxY, y + n.offsetHeight);
        });
        const cw = maxX - minX + 120, ch = maxY - minY + 120;
        scale = Math.max(0.2, Math.min(Math.min(cr.width / cw, cr.height / ch), 1.5));
        panX = (cr.width - cw * scale) / 2 - minX * scale + 60;
        panY = (cr.height - ch * scale) / 2 - minY * scale + 60;
        applyTransform(); drawAllLines(); updateZoomLabel();
    }

    function applyTransform() { canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`; }
    function updateZoomLabel() { document.getElementById('zoom-level').textContent = Math.round(scale * 100) + '%'; }

    // =================== SVG LINES ===================

    function drawAllLines() {
        svgLayer.innerHTML = '';
        if (relationships.length === 0) return;

        const activeRels = new Set();
        if (focusedTable) {
            relationships.forEach(r => {
                if (r.fromTable === focusedTable || r.toTable === focusedTable) activeRels.add(r.id);
            });
        }

        const pairOffsets = {};
        relationships.forEach(rel => {
            if (hiddenTypes.has(rel.type)) return;
            const pk = [rel.fromTable, rel.toTable].sort().join('::');
            if (!pairOffsets[pk]) pairOffsets[pk] = 0;
            const offset = pairOffsets[pk]++;
            const isActive = !focusedTable || activeRels.has(rel.id);
            drawLine(rel, isActive, offset);
        });
    }

    function drawLine(rel, isActive, parallelOffset) {
        const fn = getNodeElement(rel.fromTable), tn = getNodeElement(rel.toTable);
        if (!fn || !tn) return;

        const fcr = fn.querySelector(`[data-column="${CSS.escape(rel.fromColumn)}"]`);
        const tcr = tn.querySelector(`[data-column="${CSS.escape(rel.toColumn)}"]`);
        const fp = getAnchorPoint(fn, fcr, tn);
        const tp = getAnchorPoint(tn, tcr, fn);

        const yShift = parallelOffset * 12;
        const fs = canvasToContainer(fp.x, fp.y + yShift);
        const ts = canvasToContainer(tp.x, tp.y + yShift);
        const color = rel.type === '1:1' ? '#22c55e' : rel.type === 'N:M' ? '#f0b429' : '#4da6ff';

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', `rel-group${isActive ? '' : ' dimmed'}`);

        const co = Math.max(50, Math.min(Math.abs(ts.x - fs.x) * 0.4, 180));
        const c1 = fp.side === 'right' ? fs.x + co : fs.x - co;
        const c2 = tp.side === 'right' ? ts.x + co : ts.x - co;
        const d = `M ${fs.x} ${fs.y} C ${c1} ${fs.y}, ${c2} ${ts.y}, ${ts.x} ${ts.y}`;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'rel-line');
        path.setAttribute('stroke', color);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('opacity', isActive ? '0.7' : '0.5');
        group.appendChild(path);

        const hp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hp.setAttribute('d', d);
        hp.setAttribute('stroke', 'transparent');
        hp.setAttribute('stroke-width', '14');
        hp.setAttribute('fill', 'none');
        hp.style.pointerEvents = 'stroke';
        hp.style.cursor = 'pointer';
        group.appendChild(hp);

        // Label
        const mx = (fs.x + ts.x) / 2, my = (fs.y + ts.y) / 2;
        const label = rel.type + (rel.confidence ? ` ${rel.confidence}%` : '');
        const tw = label.length * 7 + 10;

        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bg.setAttribute('x', mx - tw / 2); bg.setAttribute('y', my - 10);
        bg.setAttribute('width', tw); bg.setAttribute('height', 20);
        bg.setAttribute('fill', '#1a1b2e'); bg.setAttribute('stroke', color);
        bg.setAttribute('stroke-width', '1'); bg.setAttribute('rx', '4');
        bg.setAttribute('opacity', isActive ? '1' : '0.4');
        group.appendChild(bg);

        const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        txt.setAttribute('x', mx); txt.setAttribute('y', my + 4);
        txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('class', 'rel-label');
        txt.setAttribute('fill', color); txt.setAttribute('font-size', '11');
        txt.textContent = label;
        group.appendChild(txt);

        // Cardinality
        appendMarker(group, fs.x, fs.y, fp.side, rel.type === '1:1' ? '1' : 'N', color);
        appendMarker(group, ts.x, ts.y, tp.side, rel.type === 'N:M' ? 'M' : '1', color);

        // Hover
        hp.addEventListener('mouseenter', () => {
            group.classList.add('highlighted'); group.classList.remove('dimmed');
            path.setAttribute('opacity', '1');
            if (fn) fn.classList.add('highlighted');
            if (tn) tn.classList.add('highlighted');
            if (fcr) fcr.style.background = 'rgba(77, 166, 255, 0.25)';
            if (tcr) tcr.style.background = 'rgba(240, 180, 41, 0.25)';
        });
        hp.addEventListener('mouseleave', () => {
            group.classList.remove('highlighted');
            if (!isActive && focusedTable) group.classList.add('dimmed');
            path.setAttribute('opacity', isActive ? '0.7' : '0.5');
            if (fn) fn.classList.remove('highlighted');
            if (tn) tn.classList.remove('highlighted');
            if (fcr) fcr.style.background = '';
            if (tcr) tcr.style.background = '';
        });

        svgLayer.appendChild(group);
    }

    function getAnchorPoint(node, colRow, otherNode) {
        const nx = parseFloat(node.style.left), ny = parseFloat(node.style.top);
        const nw = node.offsetWidth;
        const ox = parseFloat(otherNode.style.left), ow = otherNode.offsetWidth;
        const exitRight = (nx + nw / 2) < (ox + ow / 2);
        const y = colRow ? ny + colRow.offsetTop + colRow.offsetHeight / 2 : ny + node.offsetHeight / 2;
        return { x: exitRight ? nx + nw : nx, y, side: exitRight ? 'right' : 'left' };
    }

    function canvasToContainer(cx, cy) { return { x: cx * scale + panX, y: cy * scale + panY }; }

    function appendMarker(group, x, y, side, label, color) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', x + (side === 'right' ? 14 : -14));
        t.setAttribute('y', y - 10);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('font-size', '10'); t.setAttribute('font-family', 'monospace');
        t.setAttribute('fill', color); t.setAttribute('opacity', '0.8');
        t.textContent = label;
        group.appendChild(t);
    }

    function highlightTable(tableName) {
        setFocus(tableName);
        const pos = positions[tableName];
        if (pos) {
            const cr = container.getBoundingClientRect();
            panX = cr.width / 2 - pos.x * scale;
            panY = cr.height / 2 - pos.y * scale;
            applyTransform(); drawAllLines();
        }
    }

    function updateRelationships(rels) { relationships = rels; drawAllLines(); }
    function getPositions() { return positions; }
    function resetPositions() { positions = {}; }
    function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

    return {
        init, render, highlightTable, updateRelationships, drawAllLines,
        fitToScreen, getPositions, resetPositions, setFocus, clearFocus,
        setHiddenTypes, switchLayout,
    };
})();
