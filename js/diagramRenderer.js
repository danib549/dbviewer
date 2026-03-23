/**
 * Diagram Renderer Module
 * Renders table nodes on canvas with SVG relationship lines
 * Supports drag, pan, zoom
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
    }

    /**
     * Render all tables and relationships
     */
    function render(tbls, rels) {
        tables = tbls;
        relationships = rels;

        // Clear canvas
        canvas.querySelectorAll('.table-node').forEach(n => n.remove());

        // Calculate initial positions
        calculateLayout();

        // Render table nodes
        tables.forEach((table, i) => {
            renderTableNode(table, i);
        });

        // Draw lines
        requestAnimationFrame(() => drawAllLines());

        // Update zoom display
        updateZoomLabel();
    }

    /**
     * Calculate grid layout for tables
     */
    function calculateLayout() {
        if (Object.keys(positions).length === tables.length) return;

        const cols = Math.ceil(Math.sqrt(tables.length));
        const spacingX = 280;
        const spacingY = 50;
        const startX = 60;
        const startY = 60;

        // Sort tables by number of relationships (most connected first, center)
        const relCounts = {};
        tables.forEach(t => { relCounts[t.name] = 0; });
        relationships.forEach(r => {
            relCounts[r.fromTable] = (relCounts[r.fromTable] || 0) + 1;
            relCounts[r.toTable] = (relCounts[r.toTable] || 0) + 1;
        });

        const sorted = [...tables].sort((a, b) => (relCounts[b.name] || 0) - (relCounts[a.name] || 0));

        sorted.forEach((table, i) => {
            if (positions[table.name]) return;
            const col = i % cols;
            const row = Math.floor(i / cols);
            // Estimate height based on column count
            const estimatedHeight = 36 + (table.columns.length * 26) + 8;
            positions[table.name] = {
                x: startX + col * spacingX,
                y: startY + row * (Math.max(estimatedHeight, 150) + spacingY),
            };
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
        node.id = `table-${table.name}`;
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

            // Double click to view data
            row.addEventListener('dblclick', () => {
                if (onTableClick) onTableClick(table);
            });

            colContainer.appendChild(row);
        });

        node.appendChild(colContainer);

        // Single click on node body to preview
        node.addEventListener('dblclick', (e) => {
            if (e.target.closest('.table-node-header')) return;
            if (onTableClick) onTableClick(table);
        });

        canvas.appendChild(node);
    }

    // === DRAG ===
    function onDragStart(e, node, tableName) {
        if (e.button !== 0) return;
        e.stopPropagation();
        dragNode = { el: node, name: tableName };
        const rect = node.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        dragOffsetX = (e.clientX - rect.left);
        dragOffsetY = (e.clientY - rect.top);
        node.style.zIndex = 10;
        node.classList.add('highlighted');
    }

    function onTouchDragStart(e, node, tableName) {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        const touch = e.touches[0];
        dragNode = { el: node, name: tableName };
        const rect = node.getBoundingClientRect();
        dragOffsetX = touch.clientX - rect.left;
        dragOffsetY = touch.clientY - rect.top;
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
        }
    }

    function onMouseUp() {
        if (dragNode) {
            dragNode.el.style.zIndex = '';
            dragNode.el.classList.remove('highlighted');
            dragNode = null;
        }
        if (isPanning) {
            isPanning = false;
            container.classList.remove('grabbing');
        }
    }

    // Touch pan/drag
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

        // Zoom towards mouse position
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        panX = mouseX - (mouseX - panX) * (newScale / scale);
        panY = mouseY - (mouseY - panY) * (newScale / scale);

        scale = newScale;
        applyTransform();
        updateZoomLabel();
    }

    function setZoom(newScale) {
        scale = Math.max(0.2, Math.min(3, newScale));
        applyTransform();
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

        const contentW = maxX - minX + 80;
        const contentH = maxY - minY + 80;
        const scaleX = containerRect.width / contentW;
        const scaleY = containerRect.height / contentH;
        scale = Math.min(scaleX, scaleY, 1.5);
        scale = Math.max(0.2, Math.min(2, scale));

        panX = (containerRect.width - contentW * scale) / 2 - minX * scale + 40;
        panY = (containerRect.height - contentH * scale) / 2 - minY * scale + 40;

        applyTransform();
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

        // Need to use positions relative to canvas
        relationships.forEach(rel => {
            drawLine(rel);
        });
    }

    function drawLine(rel) {
        const fromNode = document.getElementById(`table-${rel.fromTable}`);
        const toNode = document.getElementById(`table-${rel.toTable}`);
        if (!fromNode || !toNode) return;

        // Find the specific column rows
        const fromColRow = fromNode.querySelector(`[data-column="${rel.fromColumn}"]`);
        const toColRow = toNode.querySelector(`[data-column="${rel.toColumn}"]`);

        // Get positions relative to canvas (before transform)
        const fromPos = getColumnAnchor(fromNode, fromColRow, toNode);
        const toPos = getColumnAnchor(toNode, toColRow, fromNode);

        // Determine color based on relationship
        const color = rel.type === '1:1' ? '#22c55e' : '#4da6ff';

        // Draw curved path
        const path = createCurvedPath(fromPos, toPos, color);
        svgLayer.appendChild(path);

        // Draw invisible wider path for hover
        const hoverPath = path.cloneNode();
        hoverPath.setAttribute('class', 'rel-line-hover');
        hoverPath.setAttribute('stroke', 'transparent');
        hoverPath.setAttribute('stroke-width', '10');
        hoverPath.style.pointerEvents = 'stroke';
        svgLayer.appendChild(hoverPath);

        // Draw relationship type label
        drawRelLabel(fromPos, toPos, rel.type, color);

        // Draw cardinality markers
        drawCardinalityMarkers(fromPos, toPos, rel.type, color);
    }

    function getColumnAnchor(node, colRow, otherNode) {
        const nodeX = parseFloat(node.style.left);
        const nodeY = parseFloat(node.style.top);
        const nodeW = node.offsetWidth;
        const nodeH = node.offsetHeight;

        const otherX = parseFloat(otherNode.style.left);

        // Determine which side the line should exit from
        const exitRight = nodeX + nodeW / 2 < otherX + otherNode.offsetWidth / 2;

        let y;
        if (colRow) {
            // Position at the column row center
            const rowRect = colRow.getBoundingClientRect();
            const nodeRect = node.getBoundingClientRect();
            const relativeY = (rowRect.top - nodeRect.top + rowRect.height / 2) / scale;
            y = nodeY + relativeY;
        } else {
            y = nodeY + nodeH / 2;
        }

        return {
            x: exitRight ? nodeX + nodeW : nodeX,
            y: y,
            side: exitRight ? 'right' : 'left'
        };
    }

    function createCurvedPath(from, to, color) {
        const dx = Math.abs(to.x - from.x);
        const controlOffset = Math.max(40, Math.min(dx * 0.4, 150));

        const cp1x = from.side === 'right' ? from.x + controlOffset : from.x - controlOffset;
        const cp2x = to.side === 'right' ? to.x + controlOffset : to.x - controlOffset;

        const d = `M ${from.x} ${from.y} C ${cp1x} ${from.y}, ${cp2x} ${to.y}, ${to.x} ${to.y}`;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'rel-line');
        path.setAttribute('stroke', color);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-width', '2');
        return path;
    }

    function drawRelLabel(from, to, type, color) {
        const midX = (from.x + to.x) / 2;
        const midY = (from.y + to.y) / 2;

        // Background rect
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const textWidth = type.length * 7 + 8;
        bg.setAttribute('x', midX - textWidth / 2);
        bg.setAttribute('y', midY - 9);
        bg.setAttribute('width', textWidth);
        bg.setAttribute('height', 18);
        bg.setAttribute('class', 'rel-label-bg');
        bg.setAttribute('fill', '#1a1b2e');
        bg.setAttribute('stroke', color);
        bg.setAttribute('stroke-width', '1');
        bg.setAttribute('rx', '4');
        svgLayer.appendChild(bg);

        // Text
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', midX);
        text.setAttribute('y', midY + 4);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'rel-label');
        text.setAttribute('fill', color);
        text.textContent = type;
        svgLayer.appendChild(text);
    }

    function drawCardinalityMarkers(from, to, type, color) {
        // Draw "1" at the "to" side (PK side) and "N" or "1" at the "from" side (FK side)
        const markerOffset = 15;

        // "From" side marker (FK side - many side)
        const fromMarkerX = from.side === 'right' ? from.x + markerOffset : from.x - markerOffset;
        drawSmallMarker(fromMarkerX, from.y - 12, type === '1:1' ? '1' : 'N', color);

        // "To" side marker (PK side - one side)
        const toMarkerX = to.side === 'right' ? to.x + markerOffset : to.x - markerOffset;
        drawSmallMarker(toMarkerX, to.y - 12, '1', color);
    }

    function drawSmallMarker(x, y, label, color) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '10');
        text.setAttribute('font-family', 'monospace');
        text.setAttribute('fill', color);
        text.setAttribute('opacity', '0.7');
        text.textContent = label;
        svgLayer.appendChild(text);
    }

    /**
     * Highlight a table node
     */
    function highlightTable(tableName) {
        canvas.querySelectorAll('.table-node').forEach(n => n.classList.remove('highlighted'));
        const node = document.getElementById(`table-${tableName}`);
        if (node) {
            node.classList.add('highlighted');
            // Scroll into view
            const pos = positions[tableName];
            if (pos) {
                const containerRect = container.getBoundingClientRect();
                panX = containerRect.width / 2 - pos.x * scale;
                panY = containerRect.height / 2 - pos.y * scale;
                applyTransform();
            }
        }
    }

    /**
     * Redraw lines (call after relationship changes)
     */
    function updateRelationships(rels) {
        relationships = rels;
        drawAllLines();
    }

    function getPositions() {
        return positions;
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
    };
})();
