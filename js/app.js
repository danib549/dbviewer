/**
 * Main Application Module
 * Wires together all modules and handles UI state
 */
const App = (() => {

    let tables = [];
    let relationships = [];
    let selectedFiles = [];

    function init() {
        setupUploadScreen();
        setupDiagramScreen();
        DataPreview.init();
    }

    // === Upload Screen ===
    function setupUploadScreen() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');
        const btnVisualize = document.getElementById('btn-visualize');

        // Click to browse
        dropZone.addEventListener('click', () => fileInput.click());

        // File input change
        fileInput.addEventListener('change', (e) => {
            addFiles(e.target.files);
            fileInput.value = '';
        });

        // Drag & drop
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('drag-over');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.csv'));
            if (files.length > 0) {
                addFiles(files);
            }
        });

        // Visualize button
        btnVisualize.addEventListener('click', startVisualization);
    }

    function addFiles(fileList) {
        const newFiles = Array.from(fileList).filter(f => {
            if (!f.name.toLowerCase().endsWith('.csv')) return false;
            return !selectedFiles.some(sf => sf.name === f.name);
        });

        selectedFiles = selectedFiles.concat(newFiles);
        renderFileList();
    }

    function removeFile(index) {
        selectedFiles.splice(index, 1);
        renderFileList();
    }

    function renderFileList() {
        const container = document.getElementById('file-list');
        const btn = document.getElementById('btn-visualize');

        container.innerHTML = selectedFiles.map((f, i) => `
            <div class="file-item">
                <span class="file-item-name">${escapeHtml(f.name)}</span>
                <span class="file-item-size">${formatSize(f.size)}</span>
                <button class="file-item-remove" onclick="App.removeFile(${i})" title="Remove">&times;</button>
            </div>
        `).join('');

        btn.disabled = selectedFiles.length === 0;
    }

    async function startVisualization() {
        const btn = document.getElementById('btn-visualize');
        btn.disabled = true;
        btn.textContent = 'Parsing...';

        try {
            tables = await CsvParser.parseFiles(selectedFiles);
            relationships = RelationshipDetector.detect(tables);

            showDiagramScreen();
        } catch (err) {
            alert('Error parsing CSV files: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'Visualize Relationships';
        }
    }

    // === Diagram Screen ===
    function setupDiagramScreen() {
        document.getElementById('btn-back').addEventListener('click', showUploadScreen);
        document.getElementById('btn-export-sql').addEventListener('click', exportSQL);
        document.getElementById('btn-export-png').addEventListener('click', exportPNG);
        document.getElementById('btn-add-relationship').addEventListener('click', showAddRelModal);
        document.getElementById('btn-save-relationship').addEventListener('click', saveRelationship);
        document.getElementById('btn-auto-detect').addEventListener('click', runAutoDetect);

        // Filter checkboxes
        document.getElementById('filter-1n').addEventListener('change', updateTypeFilters);
        document.getElementById('filter-11').addEventListener('change', updateTypeFilters);
        document.getElementById('filter-nm').addEventListener('change', updateTypeFilters);
        document.getElementById('btn-show-all').addEventListener('click', () => {
            DiagramRenderer.clearFocus();
            document.getElementById('filter-1n').checked = true;
            document.getElementById('filter-11').checked = true;
            document.getElementById('filter-nm').checked = true;
            updateTypeFilters();
        });

        // Add more CSVs
        const addCsvInput = document.getElementById('add-csv-input');
        document.getElementById('btn-add-csv').addEventListener('click', () => addCsvInput.click());
        addCsvInput.addEventListener('change', async (e) => {
            const newFiles = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.csv'));
            if (newFiles.length === 0) return;
            try {
                const newTables = await CsvParser.parseFiles(newFiles);
                tables = tables.concat(newTables);
                relationships = RelationshipDetector.detect(tables);
                showDiagramScreen();
            } catch (err) {
                alert('Error: ' + err.message);
            }
            addCsvInput.value = '';
        });

        DiagramRenderer.init((table) => {
            DataPreview.show(table);
        });
    }

    function showDiagramScreen() {
        document.getElementById('upload-screen').classList.remove('active');
        document.getElementById('diagram-screen').classList.add('active');

        // Update counters
        document.getElementById('table-count').textContent = tables.length + ' tables';
        document.getElementById('rel-count').textContent = relationships.length;

        // Render sidebar
        renderTableList();
        renderRelationshipList();

        // Render diagram
        DiagramRenderer.render(tables, relationships);

        // Fit to screen after a short delay for DOM rendering
        setTimeout(() => DiagramRenderer.fitToScreen(), 100);
    }

    function showUploadScreen() {
        document.getElementById('diagram-screen').classList.remove('active');
        document.getElementById('upload-screen').classList.add('active');
        document.getElementById('btn-visualize').disabled = false;
        document.getElementById('btn-visualize').textContent = 'Visualize Relationships';
    }

    function renderTableList() {
        const list = document.getElementById('table-list');
        list.innerHTML = tables.map((t, i) => {
            const colorIndex = i % 18;
            const colors = [
                '#6c63ff', '#f0b429', '#22c55e', '#ef4444', '#4da6ff',
                '#a78bfa', '#f472b6', '#fb923c', '#38bdf8', '#34d399',
                '#e879f9', '#fbbf24', '#f87171', '#60a5fa', '#a3e635',
                '#c084fc', '#fb7c86', '#2dd4bf'
            ];
            return `
                <li class="table-list-item" onclick="App.onTableListClick('${escapeAttr(t.name)}')">
                    <span class="dot" style="background:${colors[colorIndex]}"></span>
                    ${escapeHtml(t.name)}
                    <span class="col-count">${t.columns.length} cols</span>
                </li>
            `;
        }).join('');
    }

    function renderRelationshipList() {
        const list = document.getElementById('relationship-list');
        if (relationships.length === 0) {
            list.innerHTML = '<li style="padding:8px;color:var(--text-muted);font-size:0.8rem;">No relationships detected</li>';
            return;
        }

        list.innerHTML = relationships.map(r => `
            <li class="rel-item">
                <span class="rel-item-text">
                    <span class="rel-table">${escapeHtml(r.fromTable)}</span>.<span class="rel-col">${escapeHtml(r.fromColumn)}</span>
                    &rarr;
                    <span class="rel-table">${escapeHtml(r.toTable)}</span>.<span class="rel-col">${escapeHtml(r.toColumn)}</span>
                </span>
                <span class="rel-item-type">${r.type}</span>
                <button class="rel-item-delete" onclick="App.deleteRelationship('${r.id}')" title="Remove">&times;</button>
            </li>
        `).join('');

        document.getElementById('rel-count').textContent = relationships.length;
    }

    // === Table list click ===
    function onTableListClick(tableName) {
        document.querySelectorAll('.table-list-item').forEach(el => el.classList.remove('active'));
        event.currentTarget.classList.add('active');
        DiagramRenderer.highlightTable(tableName);
    }

    // === Relationship management ===
    function deleteRelationship(id) {
        relationships = relationships.filter(r => r.id !== id);

        // Update FK flags on columns
        tables.forEach(t => {
            t.columns.forEach(c => {
                c.isFK = relationships.some(r =>
                    (r.fromTable === t.name && r.fromColumn === c.name)
                );
            });
        });

        renderRelationshipList();
        DiagramRenderer.render(tables, relationships);
    }

    function showAddRelModal() {
        const modal = document.getElementById('add-rel-modal');
        const fromTableSel = document.getElementById('rel-from-table');
        const toTableSel = document.getElementById('rel-to-table');

        // Populate table dropdowns
        const options = tables.map(t => `<option value="${escapeAttr(t.name)}">${escapeHtml(t.name)}</option>`).join('');
        fromTableSel.innerHTML = options;
        toTableSel.innerHTML = options;

        // Populate column dropdowns for first tables
        updateColumnDropdown('rel-from-table', 'rel-from-column');
        updateColumnDropdown('rel-to-table', 'rel-to-column');

        fromTableSel.onchange = () => updateColumnDropdown('rel-from-table', 'rel-from-column');
        toTableSel.onchange = () => updateColumnDropdown('rel-to-table', 'rel-to-column');

        modal.classList.add('active');
    }

    function updateColumnDropdown(tableSelectId, colSelectId) {
        const tableName = document.getElementById(tableSelectId).value;
        const colSelect = document.getElementById(colSelectId);
        const table = tables.find(t => t.name === tableName);
        if (!table) return;

        colSelect.innerHTML = table.columns.map(c =>
            `<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)} (${c.type})</option>`
        ).join('');
    }

    function saveRelationship() {
        const fromTable = document.getElementById('rel-from-table').value;
        const fromColumn = document.getElementById('rel-from-column').value;
        const toTable = document.getElementById('rel-to-table').value;
        const toColumn = document.getElementById('rel-to-column').value;
        const type = document.getElementById('rel-type').value;

        if (fromTable === toTable && fromColumn === toColumn) {
            alert('Cannot create a self-referencing relationship on the same column.');
            return;
        }

        const rel = RelationshipDetector.createManual(fromTable, fromColumn, toTable, toColumn, type);
        relationships.push(rel);

        // Mark FK
        const table = tables.find(t => t.name === fromTable);
        if (table) {
            const col = table.columns.find(c => c.name === fromColumn);
            if (col) col.isFK = true;
        }

        renderRelationshipList();
        DiagramRenderer.render(tables, relationships);
        document.getElementById('add-rel-modal').classList.remove('active');
    }

    // === Type Filters ===
    function updateTypeFilters() {
        const hidden = [];
        if (!document.getElementById('filter-1n').checked) hidden.push('1:N');
        if (!document.getElementById('filter-11').checked) hidden.push('1:1');
        if (!document.getElementById('filter-nm').checked) hidden.push('N:M');
        DiagramRenderer.setHiddenTypes(hidden);
    }

    // === Auto Detect (deep scan) ===
    function runAutoDetect() {
        const btn = document.getElementById('btn-auto-detect');
        btn.textContent = 'Scanning...';
        btn.disabled = true;

        // Use setTimeout to let the UI update before the heavy computation
        setTimeout(() => {
            try {
                const newRels = RelationshipDetector.deepScan(tables, relationships);
                if (newRels.length > 0) {
                    relationships = relationships.concat(newRels);

                    renderRelationshipList();
                    DiagramRenderer.render(tables, relationships);
                    setTimeout(() => DiagramRenderer.fitToScreen(), 150);

                    btn.textContent = `Found ${newRels.length} new!`;
                    setTimeout(() => {
                        btn.textContent = 'Auto Detect';
                        btn.disabled = false;
                    }, 2000);
                } else {
                    btn.textContent = 'No new found';
                    setTimeout(() => {
                        btn.textContent = 'Auto Detect';
                        btn.disabled = false;
                    }, 2000);
                }
            } catch (err) {
                console.error('Auto detect error:', err);
                btn.textContent = 'Auto Detect';
                btn.disabled = false;
                alert('Error during auto-detection: ' + err.message);
            }
        }, 50);
    }

    // === Export ===
    function exportSQL() {
        let sql = '-- Generated by DB Relationship Visualizer\n';
        sql += '-- ' + new Date().toISOString() + '\n\n';

        tables.forEach(table => {
            sql += `CREATE TABLE [${table.name}] (\n`;
            const colDefs = table.columns.map(col => {
                let sqlType = mapToSqlType(col.type);
                let line = `    [${col.name}] ${sqlType}`;
                if (col.isPK) line += ' PRIMARY KEY';
                return line;
            });
            sql += colDefs.join(',\n');
            sql += '\n);\n\n';
        });

        // Foreign keys
        relationships.forEach(rel => {
            sql += `ALTER TABLE [${rel.fromTable}]\n`;
            sql += `    ADD CONSTRAINT [FK_${rel.fromTable}_${rel.toTable}]\n`;
            sql += `    FOREIGN KEY ([${rel.fromColumn}])\n`;
            sql += `    REFERENCES [${rel.toTable}] ([${rel.toColumn}]);\n\n`;
        });

        downloadFile('schema.sql', sql, 'text/sql');
    }

    function mapToSqlType(type) {
        const map = {
            'int': 'INT',
            'decimal': 'DECIMAL(18,2)',
            'bit': 'BIT',
            'datetime': 'DATETIME',
            'text': 'NVARCHAR(MAX)',
            'varchar': 'NVARCHAR(255)',
        };
        return map[type] || 'NVARCHAR(255)';
    }

    function exportPNG() {
        const canvas = document.getElementById('canvas');
        const svgLayer = document.getElementById('svg-lines');

        // Use a simple approach: capture via an offscreen canvas
        // For a proper implementation, we would use html2canvas
        // For now, export the SVG + basic info
        alert('PNG export requires opening the page in a browser. You can use the browser\'s screenshot tool (Ctrl+Shift+S in Firefox, or use browser devtools) to capture the diagram.');
    }

    // === Utilities ===
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    }

    function downloadFile(filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // Expose public methods
    return {
        init,
        removeFile,
        onTableListClick,
        deleteRelationship,
    };
})();

// Start app
document.addEventListener('DOMContentLoaded', App.init);
