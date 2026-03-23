/**
 * Data Preview Module
 * Shows table data in a modal with search/filter
 */
const DataPreview = (() => {

    const modal = () => document.getElementById('data-modal');
    const title = () => document.getElementById('modal-title');
    const stats = () => document.getElementById('modal-stats');
    const tableWrap = () => document.getElementById('modal-table');
    const searchInput = () => document.getElementById('modal-search');
    const closeBtn = () => document.getElementById('modal-close');

    let currentTable = null;
    let filteredData = [];

    function init() {
        closeBtn().addEventListener('click', close);
        searchInput().addEventListener('input', onSearch);
        modal().addEventListener('click', (e) => {
            if (e.target === modal()) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal().classList.contains('active')) {
                close();
            }
        });
    }

    /**
     * Show data preview for a table
     * @param {Object} table - table object from CsvParser
     */
    function show(table) {
        currentTable = table;
        filteredData = table.data;
        searchInput().value = '';
        title().textContent = table.name;

        renderStats(table);
        renderTable(table.columns, table.data);
        modal().classList.add('active');
    }

    function close() {
        modal().classList.remove('active');
        currentTable = null;
    }

    function onSearch(e) {
        const query = e.target.value.toLowerCase().trim();
        if (!currentTable) return;

        if (!query) {
            filteredData = currentTable.data;
        } else {
            filteredData = currentTable.data.filter(row => {
                return Object.values(row).some(val =>
                    (val || '').toString().toLowerCase().includes(query)
                );
            });
        }

        renderTable(currentTable.columns, filteredData);
        renderStats(currentTable, filteredData.length);
    }

    function renderStats(table, shownCount) {
        const count = shownCount !== undefined ? shownCount : table.data.length;
        stats().innerHTML = `
            <span>Columns: ${table.columns.length}</span>
            <span>Rows: ${count}${shownCount !== undefined && shownCount !== table.data.length ? ' / ' + table.data.length : ''}</span>
        `;
    }

    function renderTable(columns, data) {
        const maxRows = 200;
        const displayData = data.slice(0, maxRows);

        let html = '<thead><tr>';
        for (const col of columns) {
            let cls = '';
            if (col.isPK) cls = 'pk-col';
            else if (col.isFK) cls = 'fk-col';
            html += `<th class="${cls}" title="${col.type}">${escapeHtml(col.name)}</th>`;
        }
        html += '</tr></thead><tbody>';

        for (const row of displayData) {
            html += '<tr>';
            for (const col of columns) {
                const val = row[col.name];
                const display = val === null || val === undefined ? '' : val;
                html += `<td title="${escapeHtml(String(display))}">${escapeHtml(String(display))}</td>`;
            }
            html += '</tr>';
        }

        if (data.length > maxRows) {
            html += `<tr><td colspan="${columns.length}" style="text-align:center;color:var(--text-muted);padding:12px;">
                Showing ${maxRows} of ${data.length} rows
            </td></tr>`;
        }

        html += '</tbody>';
        tableWrap().innerHTML = html;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    return { init, show, close };
})();
