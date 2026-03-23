/**
 * Relationship Detector Module
 * Auto-detects FK relationships between tables based on column naming conventions
 */
const RelationshipDetector = (() => {

    /**
     * Detect relationships between all tables
     * @param {Object[]} tables - Array of table objects from CsvParser
     * @returns {Object[]} relationships
     */
    function detect(tables) {
        const relationships = [];
        const tableMap = buildTableMap(tables);

        for (const table of tables) {
            for (const col of table.columns) {
                const found = findRelationship(table, col, tables, tableMap);
                if (found && !isDuplicate(relationships, found)) {
                    relationships.push(found);
                    // Mark columns as FK
                    col.isFK = true;
                }
            }
        }

        return relationships;
    }

    /**
     * Build a lookup map of table names (various forms) to table objects
     */
    function buildTableMap(tables) {
        const map = {};
        for (const t of tables) {
            const lower = t.name.toLowerCase();
            map[lower] = t;
            // Also add singular/plural variants
            if (lower.endsWith('s')) {
                map[lower.slice(0, -1)] = t; // "orders" -> "order"
            }
            if (lower.endsWith('ies')) {
                map[lower.slice(0, -3) + 'y'] = t; // "categories" -> "category"
            }
            if (lower.endsWith('es') && !lower.endsWith('ies')) {
                map[lower.slice(0, -2)] = t; // "addresses" -> "address"
            }
            // Add plural if singular
            if (!lower.endsWith('s')) {
                map[lower + 's'] = t;
            }
        }
        return map;
    }

    /**
     * Try to find a relationship for a given column
     */
    function findRelationship(sourceTable, col, allTables, tableMap) {
        const colName = col.name;

        // Skip if this is likely the table's own PK
        if (col.isPK) return null;

        // Pattern 1: {TableName}Id or {TableName}_Id
        let match = colName.match(/^(.+?)_?[Ii][Dd]$/);
        if (match) {
            const candidate = match[1].toLowerCase();
            // Don't match if candidate is the same table
            if (candidate === sourceTable.name.toLowerCase()) return null;
            if (candidate === sourceTable.name.toLowerCase().replace(/s$/, '')) return null;

            const targetTable = tableMap[candidate];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = findPKColumn(targetTable);
                if (targetCol) {
                    return {
                        id: generateId(),
                        fromTable: sourceTable.name,
                        fromColumn: colName,
                        toTable: targetTable.name,
                        toColumn: targetCol.name,
                        type: '1:N',
                    };
                }
            }
        }

        // Pattern 2: FK_{TableName} or fk_{TableName}
        match = colName.match(/^[Ff][Kk]_(.+)/);
        if (match) {
            const candidate = match[1].toLowerCase().replace(/_?id$/i, '');
            const targetTable = tableMap[candidate];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = findPKColumn(targetTable);
                if (targetCol) {
                    return {
                        id: generateId(),
                        fromTable: sourceTable.name,
                        fromColumn: colName,
                        toTable: targetTable.name,
                        toColumn: targetCol.name,
                        type: '1:N',
                    };
                }
            }
        }

        // Pattern 3: Exact column name match with another table's PK
        for (const otherTable of allTables) {
            if (otherTable.name === sourceTable.name) continue;
            for (const otherCol of otherTable.columns) {
                if (otherCol.isPK && otherCol.name === colName) {
                    return {
                        id: generateId(),
                        fromTable: sourceTable.name,
                        fromColumn: colName,
                        toTable: otherTable.name,
                        toColumn: otherCol.name,
                        type: '1:N',
                    };
                }
            }
        }

        // Pattern 4: Column named {TableName}_{ColumnName} e.g., Order_Id -> Orders.Id
        match = colName.match(/^(.+?)_(.+)$/);
        if (match) {
            const tablePart = match[1].toLowerCase();
            const colPart = match[2];
            const targetTable = tableMap[tablePart];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = targetTable.columns.find(c =>
                    c.name.toLowerCase() === colPart.toLowerCase()
                );
                if (targetCol) {
                    return {
                        id: generateId(),
                        fromTable: sourceTable.name,
                        fromColumn: colName,
                        toTable: targetTable.name,
                        toColumn: targetCol.name,
                        type: '1:N',
                    };
                }
            }
        }

        return null;
    }

    /**
     * Find the PK column of a table
     */
    function findPKColumn(table) {
        // First check for marked PK
        let pk = table.columns.find(c => c.isPK);
        if (pk) return pk;

        // Check for column named "Id"
        pk = table.columns.find(c => /^[Ii][Dd]$/.test(c.name));
        if (pk) return pk;

        // Check for {TableName}Id
        const tableNameLower = table.name.toLowerCase();
        pk = table.columns.find(c => c.name.toLowerCase() === tableNameLower + 'id');
        if (pk) return pk;

        // Check for {TableName}_Id
        pk = table.columns.find(c => c.name.toLowerCase() === tableNameLower + '_id');
        if (pk) return pk;

        // Fallback: first column that has "id" in name
        pk = table.columns.find(c => /id$/i.test(c.name));
        return pk || null;
    }

    /**
     * Check for duplicate relationship
     */
    function isDuplicate(relationships, newRel) {
        return relationships.some(r =>
            (r.fromTable === newRel.fromTable && r.fromColumn === newRel.fromColumn &&
             r.toTable === newRel.toTable && r.toColumn === newRel.toColumn) ||
            (r.fromTable === newRel.toTable && r.fromColumn === newRel.toColumn &&
             r.toTable === newRel.fromTable && r.toColumn === newRel.fromColumn)
        );
    }

    let idCounter = 0;
    function generateId() {
        return 'rel_' + (++idCounter);
    }

    /**
     * Add a manual relationship
     */
    function createManual(fromTable, fromColumn, toTable, toColumn, type) {
        return {
            id: generateId(),
            fromTable,
            fromColumn,
            toTable,
            toColumn,
            type: type || '1:N',
        };
    }

    return { detect, createManual };
})();
