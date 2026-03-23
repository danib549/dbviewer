/**
 * Diagram Renderer Module
 * Renders table nodes on canvas with SVG relationship lines
 * Supports drag, pan, zoom, hover highlight, focus mode, filtering
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

    // Focus state: when a table is clicked in sidebar, only show its relationships
    let focusedTable = null;
    // Filter state
    let hiddenTypes = new Set();

    function init(onTableClickCb) {
        canvas = document.getElementById('canvas');
        svgLayer = document.getElementById('svg-lines');
        container = document.getElementById('canvas-container');
        onTableClick = onTableClickCb;

        // Pan events
        container.addEventListener('mousedown', onPanStart);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // Zoom
        container.addEventListener('wheel', onWheel, { passive: false });

        // Touch support
        container.addEventListener('touchstart', onTouchStart, { passive: false });
        container.addEventListener('touchmove', onTouchMove, { passive: false });
        container.addEventListener('touchend', onTouchEnd);

        // Buttons
        document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(scale + 0.1));
        document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(scale - 0.1));
        document.getElementById('btn-zoom-fit').addEventListener('click', fitToScreen);

        // Redraw lines on window resize
        window.addEventListener('resize', () => drawAllLines());

        // Click on empty canvas clears focus
        container.addEventListener('click', (e) => {
            if (!e.target.closest('.table-node')) {
                clearFocus();
            }
        });
    }

    /**
     * Render all tables and relationships
     */
    function render(tbls, rels) {
        tables = tbls;
        relationships = rels;

        // Clear canvas (keep SVG layer)
        canvas.querySelectorAll('.table-node').forEach(n => n.remove());

        // Calculate initial positions
        calculateLayout();

        // Render table nodes
        tables.forEach((table, i) => {
            renderTableNode(table, i);
        });

        // Draw lines after DOM is ready
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                drawAllLines();
            });
        });

        updateZoomLabel();
    }

    /**
     * Calculate grid layout for tables
     */
    function calculateLayout() {
        if (Object.keys(positions).length === tables.length) return;

        const cols = Math.ceil(Math.sqrt(tables.length));
        const spacingX = 300;
        const startX = 60;
        const startY = 60;

        const relCounts = {};
        tables.forEach(t => { relCounts[t.name] = 0; });
        relationships.forEach(r => {
            relCounts[r.fromTable] = (relCounts[r.fromTable] || 0) + 1;
            relCounts[r.toTable] = (relCounts[r.toTable] || 0) + 1;
        });

        const sorted = [...tables].sort((a, b) => (relCounts[b.name] || 0) - (relCounts[a.name] || 0));
        const rowHeights = {};

        sorted.forEach((table, i) => {
            if (positions[table.name]) return;
            const col = i % cols;
            const row = Math.floor(i / cols);
            const estimatedHeight = 40 + (table.columns.length * 26) + 12;

            if (!rowHeights[row]) rowHeights[row] = 0;

            let yOffset = startY;
            for (let r = 0; r < row; r++) {
                yOffset += (rowHeights[r] || 200) + 60;
            }

            positions[table.name] = {
                x: startX + col * spacingX,
                y: yOffset,
            };

            rowHeights[row] = Math.max(rowHeights[row] || 0, estimatedHeight);
        });
    }

    /**
     * Render a single table node
     */
    function renderTableNode(table, index) {
        const pos = positions[table.name];
        const colorIndex = index % COLORS.length;

        const node = document.createElement('div');
        node.className = `table-node table-color-${colorIndex}`;
        node.id = `tbl-${sanitizeId(table.name)}`;
        node.style.left = pos.x + 'px';
        node.style.top = pos.y + 'px';
        node.dataset.table = table.name;

        // Header
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
        node.appendChild(header);

        // Click header to focus on this table's relationships
        header.addEventListener('click', (e) => {
            if (dragNode) return; // don't focus during drag
            e.stopPropagation();
            setFocus(table.name);
        });

        // Columns
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

            let iconClass = '';
            let iconText = '';
            if (col.isPK) { iconClass = 'col-icon pk'; iconText = 'PK'; }
            else if (col.isFK) { iconClass = 'col-icon fk'; iconText = 'FK'; }

            row.innerHTML = `
                <span class="${iconClass}">${iconText}</span>
                <span class="col-name">${escapeHtml(col.name)}</span>
                <span class="col-type">${col.type}</span>
            `;

            row.addEventListener('dblclick', () => {
                if (onTableClick) onTableClick(table);
            });

            colContainer.appendChild(row);
        });

        node.appendChild(colContainer);

        node.addEventListener('dblclick', (e) => {
            if (e.target.closest('.table-node-header')) {
                if (onTableClick) onTableClick(table);
                return;
            }
            if (onTableClick) onTableClick(table);
        });

        canvas.appendChild(node);
    }

    function sanitizeId(name) {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function getNodeElement(tableName) {
        return document.getElementById(`tbl-${sanitizeId(tableName)}`);
    }

    // === FOCUS MODE ===
    function setFocus(tableName) {
        if (focusedTable === tableName) {
            clearFocus();
            return;
        }
        focusedTable = tableName;
        applyFocusDimming();
        drawAllLines();
    }

    function clearFocus() {
        if (!focusedTable) return;
        focusedTable = null;
        // Remove all dim/focus classes
        canvas.querySelectorAll('.table-node').forEach(n => {
            n.classList.remove('dimmed', 'focused');
        });
        drawAllLines();
    }

    function applyFocusDimming() {
        if (!focusedTable) return;

        // Find all tables connected to the focused table
        const connectedTables = new Set([focusedTable]);
        relationships.forEach(r => {
            if (r.fromTable === focusedTable) connectedTables.add(r.toTable);
            if (r.toTable === focusedTable) connectedTables.add(r.fromTable);
        });

        canvas.querySelectorAll('.table-node').forEach(n => {
            const tName = n.dataset.table;
            if (tName === focusedTable) {
                n.classList.add('focused');
                n.classList.remove('dimmed');
            } else if (connectedTables.has(tName)) {
                n.classList.remove('dimmed', 'focused');
            } else {
                n.classList.add('dimmed');
                n.classList.remove('focused');
            }
        });
    }

    // === FILTER ===
    function setHiddenTypes(types) {
        hiddenTypes = new Set(types);
        drawAllLines();
    }

    // === DRAG ===
    let wasDragged = false;

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
        e.preventDefault();
        e.stopPropagation();
        wasDragged = false;
        const touch = e.touches[0];
        dragNode = { el: node, name: tableName };
        const rect = node.getBoundingClientRect();
        dragOffsetX = (touch.clientX - rect.left) / scale;
        dragOffsetY = (touch.clientY - rect.top) / scale;
        node.style.zIndex = 10;
        node.classList.add('highlighted');
    }

    // === PAN ===
    function onPanStart(e) {
        if (dragNode) return;
        if (e.target.closest('.table-node')) return;
        isPanning = true;
        panStartX = e.clientX - panX;
        panStartY = e.clientY - panY;
        container.classList.add('grabbing');
    }

    function onMouseMove(e) {
        if (dragNode) {
            wasDragged = true;
            const canvasRect = container.getBoundingClientRect();
            const newX = (e.clientX - canvasRect.left - panX) / scale - dragOffsetX;
            const newY = (e.clientY - canvasRect.top - panY) / scale - dragOffsetY;
            dragNode.el.style.left = newX + 'px';
            dragNode.el.style.top = newY + 'px';
            positions[dragNode.name] = { x: newX, y: newY };
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
            // If user dragged, don't trigger focus
            if (wasDragged) {
                // prevent the click event from firing focus
            }
            dragNode = null;
        }
        if (isPanning) {
            isPanning = false;
            container.classList.remove('grabbing');
        }
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
            e.preventDefault();
            wasDragged = true;
            const touch = e.touches[0];
            const canvasRect = container.getBoundingClientRect();
            const newX = (touch.clientX - canvasRect.left - panX) / scale - dragOffsetX;
            const newY = (touch.clientY - canvasRect.top - panY) / scale - dragOffsetY;
            dragNode.el.style.left = newX + 'px';
            dragNode.el.style.top = newY + 'px';
            positions[dragNode.name] = { x: newX, y: newY };
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
        if (dragNode) {
            dragNode.el.style.zIndex = '';
            dragNode.el.classList.remove('highlighted');
            dragNode = null;
        }
        isPanning = false;
    }

    // === ZOOM ===
    function onWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.08 : 0.08;
        const newScale = Math.max(0.2, Math.min(3, scale + delta));

        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        panX = mouseX - (mouseX - panX) * (newScale / scale);
        panY = mouseY - (mouseY - panY) * (newScale / scale);

        scale = newScale;
        applyTransform();
        drawAllLines();
        updateZoomLabel();
    }

    function setZoom(newScale) {
        scale = Math.max(0.2, Math.min(3, newScale));
        applyTransform();
        drawAllLines();
        updateZoomLabel();
    }

    function fitToScreen() {
        if (tables.length === 0) return;

        const containerRect = container.getBoundingClientRect();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        canvas.querySelectorAll('.table-node').forEach(node => {
            const x = parseFloat(node.style.left);
            const y = parseFloat(node.style.top);
            const w = node.offsetWidth;
            const h = node.offsetHeight;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + w);
            maxY = Math.max(maxY, y + h);
        });

        const contentW = maxX - minX + 120;
        const contentH = maxY - minY + 120;
        const scaleX = containerRect.width / contentW;
        const scaleY = containerRect.height / contentH;
        scale = Math.min(scaleX, scaleY, 1.5);
        scale = Math.max(0.2, Math.min(2, scale));

        panX = (containerRect.width - contentW * scale) / 2 - minX * scale + 60;
        panY = (containerRect.height - contentH * scale) / 2 - minY * scale + 60;

        applyTransform();
        drawAllLines();
        updateZoomLabel();
    }

    function applyTransform() {
        canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    function updateZoomLabel() {
        document.getElementById('zoom-level').textContent = Math.round(scale * 100) + '%';
    }

    // === SVG LINES ===
    function drawAllLines() {
        svgLayer.innerHTML = '';

        if (relationships.length === 0) return;

        // Determine which relationships are "active" (related to focused table)
        const activeRels = new Set();
        if (focusedTable) {
            relationships.forEach(r => {
                if (r.fromTable === focusedTable || r.toTable === focusedTable) {
                    activeRels.add(r.id);
                }
            });
        }

        // Separate lines into offset groups to avoid overlap between same two tables
        const pairOffsets = {};

        relationships.forEach(rel => {
            // Skip filtered types
            if (hiddenTypes.has(rel.type)) return;

            // Calculate offset for parallel lines between same table pair
            const pairKey = [rel.fromTable, rel.toTable].sort().join('::');
            if (!pairOffsets[pairKey]) pairOffsets[pairKey] = 0;
            const offset = pairOffsets[pairKey];
            pairOffsets[pairKey]++;

            const isActive = !focusedTable || activeRels.has(rel.id);
            drawLine(rel, isActive, offset);
        });
    }

    function drawLine(rel, isActive, parallelOffset) {
        const fromNode = getNodeElement(rel.fromTable);
        const toNode = getNodeElement(rel.toTable);
        if (!fromNode || !toNode) return;

        const fromColRow = fromNode.querySelector(`[data-column="${CSS.escape(rel.fromColumn)}"]`);
        const toColRow = toNode.querySelector(`[data-column="${CSS.escape(rel.toColumn)}"]`);

        const fromPos = getAnchorPoint(fromNode, fromColRow, toNode);
        const toPos = getAnchorPoint(toNode, toColRow, fromNode);

        // Apply small vertical offset for parallel lines between same tables
        const yShift = parallelOffset * 12;
        const fromScreen = canvasToContainer(fromPos.x, fromPos.y + yShift);
        const toScreen = canvasToContainer(toPos.x, toPos.y + yShift);

        const color = rel.type === '1:1' ? '#22c55e' : rel.type === 'N:M' ? '#f0b429' : '#4da6ff';

        // Create a group for this relationship
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', `rel-group${isActive ? '' : ' dimmed'}`);
        group.dataset.relId = rel.id;
        group.dataset.fromTable = rel.fromTable;
        group.dataset.toTable = rel.toTable;

        // Curved path
        const controlOffset = Math.max(50, Math.min(Math.abs(toScreen.x - fromScreen.x) * 0.4, 180));
        const cp1x = fromPos.side === 'right' ? fromScreen.x + controlOffset : fromScreen.x - controlOffset;
        const cp2x = toPos.side === 'right' ? toScreen.x + controlOffset : toScreen.x - controlOffset;
        const d = `M ${fromScreen.x} ${fromScreen.y} C ${cp1x} ${fromScreen.y}, ${cp2x} ${toScreen.y}, ${toScreen.x} ${toScreen.y}`;

        // Main line
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'rel-line');
        path.setAttribute('stroke', color);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('opacity', isActive ? '0.7' : '0.5');
        group.appendChild(path);

        // Wider invisible hover path
        const hoverPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hoverPath.setAttribute('d', d);
        hoverPath.setAttribute('stroke', 'transparent');
        hoverPath.setAttribute('stroke-width', '14');
        hoverPath.setAttribute('fill', 'none');
        hoverPath.style.pointerEvents = 'stroke';
        hoverPath.style.cursor = 'pointer';
        group.appendChild(hoverPath);

        // Label at midpoint
        const midX = (fromScreen.x + toScreen.x) / 2;
        const midY = (fromScreen.y + toScreen.y) / 2;

        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const label = rel.type + (rel.confidence ? ` ${rel.confidence}%` : '');
        const textWidth = label.length * 7 + 10;
        bg.setAttribute('x', midX - textWidth / 2);
        bg.setAttribute('y', midY - 10);
        bg.setAttribute('width', textWidth);
        bg.setAttribute('height', 20);
        bg.setAttribute('fill', '#1a1b2e');
        bg.setAttribute('stroke', color);
        bg.setAttribute('stroke-width', '1');
        bg.setAttribute('rx', '4');
        bg.setAttribute('opacity', isActive ? '1' : '0.4');
        group.appendChild(bg);

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', midX);
        text.setAttribute('y', midY + 4);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'rel-label');
        text.setAttribute('fill', color);
        text.setAttribute('font-size', '11');
        text.textContent = label;
        group.appendChild(text);

        // Cardinality markers
        const fLabel = rel.type === '1:1' ? '1' : 'N';
        const tLabel = rel.type === 'N:M' ? 'M' : '1';
        appendMarker(group, fromScreen.x, fromScreen.y, fromPos.side, fLabel, color);
        appendMarker(group, toScreen.x, toScreen.y, toPos.side, tLabel, color);

        // Hover interactions - highlight this line + connected tables
        hoverPath.addEventListener('mouseenter', () => {
            group.classList.add('highlighted');
            group.classList.remove('dimmed');
            path.setAttribute('opacity', '1');

            // Highlight connected tables
            const fn = getNodeElement(rel.fromTable);
            const tn = getNodeElement(rel.toTable);
            if (fn) fn.classList.add('highlighted');
            if (tn) tn.classList.add('highlighted');

            // Highlight connected column rows
            if (fromColRow) fromColRow.style.background = 'rgba(77, 166, 255, 0.25)';
            if (toColRow) toColRow.style.background = 'rgba(240, 180, 41, 0.25)';
        });

        hoverPath.addEventListener('mouseleave', () => {
            group.classList.remove('highlighted');
            if (!isActive && focusedTable) group.classList.add('dimmed');
            path.setAttribute('opacity', isActive ? '0.7' : '0.5');

            const fn = getNodeElement(rel.fromTable);
            const tn = getNodeElement(rel.toTable);
            if (fn) fn.classList.remove('highlighted');
            if (tn) tn.classList.remove('highlighted');

            if (fromColRow) fromColRow.style.background = '';
            if (toColRow) toColRow.style.background = '';
        });

        svgLayer.appendChild(group);
    }

    function getAnchorPoint(node, colRow, otherNode) {
        const nodeX = parseFloat(node.style.left);
        const nodeY = parseFloat(node.style.top);
        const nodeW = node.offsetWidth;
        const otherX = parseFloat(otherNode.style.left);
        const otherW = otherNode.offsetWidth;

        const exitRight = (nodeX + nodeW / 2) < (otherX + otherW / 2);

        let y;
        if (colRow) {
            y = nodeY + colRow.offsetTop + colRow.offsetHeight / 2;
        } else {
            y = nodeY + node.offsetHeight / 2;
        }

        return {
            x: exitRight ? nodeX + nodeW : nodeX,
            y: y,
            side: exitRight ? 'right' : 'left'
        };
    }

    function canvasToContainer(cx, cy) {
        return {
            x: cx * scale + panX,
            y: cy * scale + panY
        };
    }

    function appendMarker(group, x, y, side, label, color) {
        const offset = side === 'right' ? 14 : -14;
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x + offset);
        text.setAttribute('y', y - 10);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '10');
        text.setAttribute('font-family', 'monospace');
        text.setAttribute('fill', color);
        text.setAttribute('opacity', '0.8');
        text.textContent = label;
        group.appendChild(text);
    }

    /**
     * Highlight a table and focus on its relationships
     */
    function highlightTable(tableName) {
        setFocus(tableName);

        // Pan to center the table
        const pos = positions[tableName];
        if (pos) {
            const containerRect = container.getBoundingClientRect();
            panX = containerRect.width / 2 - pos.x * scale;
            panY = containerRect.height / 2 - pos.y * scale;
            applyTransform();
            drawAllLines();
        }
    }

    function updateRelationships(rels) {
        relationships = rels;
        drawAllLines();
    }

    function getPositions() {
        return positions;
    }

    function resetPositions() {
        positions = {};
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    return {
        init,
        render,
        highlightTable,
        updateRelationships,
        drawAllLines,
        fitToScreen,
        getPositions,
        resetPositions,
        setFocus,
        clearFocus,
        setHiddenTypes,
    };
})();
