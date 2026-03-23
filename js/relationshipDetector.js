/**
 * Relationship Detector Module
 * Auto-detects FK relationships between tables based on column naming conventions
 * AND by scanning actual data values for matches
 */
const RelationshipDetector = (() => {

    let idCounter = 0;
    function generateId() {
        return 'rel_' + (++idCounter);
    }

    /**
     * Detect relationships using column name patterns
     * @param {Object[]} tables - Array of table objects from CsvParser
     * @returns {Object[]} relationships
     */
    function detect(tables) {
        const relationships = [];
        const tableMap = buildTableMap(tables);

        // First pass: mark PKs more aggressively
        for (const table of tables) {
            markPrimaryKeys(table);
        }

        // Second pass: find FK relationships by column name patterns
        for (const table of tables) {
            for (const col of table.columns) {
                const found = findRelationshipByName(table, col, tables, tableMap);
                if (found && !isDuplicate(relationships, found)) {
                    relationships.push(found);
                    col.isFK = true;
                }
            }
        }

        return relationships;
    }

    /**
     * Deep scan: detect relationships by comparing actual data values across tables.
     * This finds relationships that name-based heuristics miss.
     * @param {Object[]} tables
     * @param {Object[]} existingRels - already detected relationships to avoid duplicates
     * @returns {Object[]} new relationships found
     */
    function deepScan(tables, existingRels) {
        const newRels = [];
        const allRels = [...existingRels];

        for (const table of tables) {
            markPrimaryKeys(table);
        }

        // For each table, for each column, try to match values against PK columns of other tables
        for (const srcTable of tables) {
            for (const srcCol of srcTable.columns) {
                if (srcCol.isPK) continue; // Skip own PKs
                if (srcCol.type === 'datetime' || srcCol.type === 'text' || srcCol.type === 'bit') continue;

                // Get unique non-empty values from this column (sample)
                const srcValues = getUniqueValues(srcTable.data, srcCol.name, 200);
                if (srcValues.size === 0) continue;
                // Skip if too many unique values relative to row count (likely not an FK)
                // But allow it - user wants broad detection

                for (const tgtTable of tables) {
                    if (tgtTable.name === srcTable.name) continue;

                    for (const tgtCol of tgtTable.columns) {
                        // Check if this relationship already exists
                        const testRel = {
                            fromTable: srcTable.name,
                            fromColumn: srcCol.name,
                            toTable: tgtTable.name,
                            toColumn: tgtCol.name
                        };
                        if (isDuplicate(allRels, testRel)) continue;

                        // Get unique values from target column
                        const tgtValues = getUniqueValues(tgtTable.data, tgtCol.name, 500);
                        if (tgtValues.size === 0) continue;

                        // Check if source values are a subset of target values
                        const matchCount = countMatches(srcValues, tgtValues);
                        const matchRatio = matchCount / srcValues.size;

                        // High match ratio = likely FK relationship
                        if (matchRatio >= 0.7 && srcValues.size >= 2 && matchCount >= 2) {
                            // Prefer when target looks like a PK (fewer or equal unique values)
                            // and source has repeated values (many rows, fewer unique = FK pattern)
                            const srcUniqueRatio = srcValues.size / Math.max(srcTable.data.length, 1);
                            const tgtUniqueRatio = tgtValues.size / Math.max(tgtTable.data.length, 1);

                            // Target should have high uniqueness (like a PK) OR be marked as PK
                            if (tgtCol.isPK || tgtUniqueRatio > 0.5 || tgtCol.name.toLowerCase().includes('id')) {
                                const rel = {
                                    id: generateId(),
                                    fromTable: srcTable.name,
                                    fromColumn: srcCol.name,
                                    toTable: tgtTable.name,
                                    toColumn: tgtCol.name,
                                    type: srcUniqueRatio > 0.9 ? '1:1' : '1:N',
                                    confidence: Math.round(matchRatio * 100),
                                    method: 'data-scan'
                                };
                                newRels.push(rel);
                                allRels.push(rel);
                                srcCol.isFK = true;
                            }
                        }
                    }
                }
            }
        }

        return newRels;
    }

    function getUniqueValues(data, colName, maxSample) {
        const values = new Set();
        const limit = Math.min(data.length, maxSample);
        for (let i = 0; i < limit; i++) {
            const val = (data[i][colName] || '').toString().trim();
            if (val && val !== '' && val !== 'NULL' && val !== 'null') {
                values.add(val);
            }
        }
        return values;
    }

    function countMatches(srcValues, tgtValues) {
        let count = 0;
        for (const v of srcValues) {
            if (tgtValues.has(v)) count++;
        }
        return count;
    }

    /**
     * Mark primary key columns more aggressively
     */
    function markPrimaryKeys(table) {
        const tName = table.name.toLowerCase();

        for (const col of table.columns) {
            const cName = col.name.toLowerCase().trim();

            // Exact "Id", "ID", "id"
            if (cName === 'id') { col.isPK = true; continue; }

            // {TableName}Id or {TableName}_Id or {TableName}ID
            if (cName === tName + 'id' || cName === tName + '_id') { col.isPK = true; continue; }

            // Singular version: "Orders" table -> "OrderId"
            const singular = singularize(tName);
            if (cName === singular + 'id' || cName === singular + '_id') { col.isPK = true; continue; }

            // PK_ prefix
            if (cName.startsWith('pk_') || cName.startsWith('pk ')) { col.isPK = true; continue; }

            // Column named exactly the same as table + key
            if (cName === tName + 'key' || cName === tName + '_key') { col.isPK = true; continue; }
            if (cName === singular + 'key' || cName === singular + '_key') { col.isPK = true; continue; }

            // Common patterns: "Code" as PK for lookup tables
            if (cName === tName + 'code' || cName === tName + '_code') { col.isPK = true; continue; }
            if (cName === singular + 'code' || cName === singular + '_code') { col.isPK = true; continue; }
        }

        // If no PK found, check if first column looks like an ID
        if (!table.columns.some(c => c.isPK) && table.columns.length > 0) {
            const first = table.columns[0];
            const fn = first.name.toLowerCase();
            if (fn.endsWith('id') || fn.endsWith('_id') || fn === 'id' || fn.endsWith('key') || fn.endsWith('code')) {
                first.isPK = true;
            }
        }
    }

    /**
     * Build a lookup map of table names (various forms) to table objects
     */
    function buildTableMap(tables) {
        const map = {};
        for (const t of tables) {
            const lower = t.name.toLowerCase();
            map[lower] = t;

            // Singular/plural variants
            if (lower.endsWith('ies')) {
                map[lower.slice(0, -3) + 'y'] = t;
            } else if (lower.endsWith('ses') || lower.endsWith('xes') || lower.endsWith('zes') || lower.endsWith('ches') || lower.endsWith('shes')) {
                map[lower.slice(0, -2)] = t;
            } else if (lower.endsWith('s')) {
                map[lower.slice(0, -1)] = t;
            }

            if (!lower.endsWith('s')) {
                map[lower + 's'] = t;
            }

            // Also add without common prefixes like tbl, tbl_, t_
            for (const prefix of ['tbl_', 'tbl', 't_', 'dim_', 'dim', 'fact_', 'fact', 'lkp_', 'lu_']) {
                if (lower.startsWith(prefix)) {
                    const stripped = lower.slice(prefix.length);
                    map[stripped] = t;
                    // Also singular/plural of stripped
                    if (stripped.endsWith('s')) map[stripped.slice(0, -1)] = t;
                    else map[stripped + 's'] = t;
                }
            }
        }
        return map;
    }

    function singularize(word) {
        if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
        if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2);
        if (word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2);
        if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
        return word;
    }

    /**
     * Try to find a relationship for a given column based on its name
     */
    function findRelationshipByName(sourceTable, col, allTables, tableMap) {
        const colName = col.name;
        const colLower = colName.toLowerCase().trim();

        // Skip if this is the table's own PK
        if (col.isPK) return null;

        // Pattern 1: {TableName}Id, {TableName}_Id, {TableName}ID
        let match = colLower.match(/^(.+?)_?id$/);
        if (match) {
            const candidate = match[1];
            if (candidate === sourceTable.name.toLowerCase()) return null;
            if (candidate === singularize(sourceTable.name.toLowerCase())) return null;

            const targetTable = tableMap[candidate];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = findPKColumn(targetTable);
                if (targetCol) {
                    return makeRel(sourceTable.name, colName, targetTable.name, targetCol.name);
                }
            }
        }

        // Pattern 2: FK_{TableName}, fk_{TableName}, FK_{TableName}_Id
        match = colLower.match(/^fk_(.+)/);
        if (match) {
            const candidate = match[1].replace(/_?id$/i, '').replace(/_/g, '');
            const targetTable = tableMap[candidate];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = findPKColumn(targetTable);
                if (targetCol) {
                    return makeRel(sourceTable.name, colName, targetTable.name, targetCol.name);
                }
            }
        }

        // Pattern 3: {TableName}Key, {TableName}_Key
        match = colLower.match(/^(.+?)_?key$/);
        if (match) {
            const candidate = match[1];
            if (candidate === sourceTable.name.toLowerCase()) return null;
            if (candidate === singularize(sourceTable.name.toLowerCase())) return null;

            const targetTable = tableMap[candidate];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = findPKColumn(targetTable);
                if (targetCol) {
                    return makeRel(sourceTable.name, colName, targetTable.name, targetCol.name);
                }
            }
        }

        // Pattern 4: {TableName}Code, {TableName}_Code
        match = colLower.match(/^(.+?)_?code$/);
        if (match) {
            const candidate = match[1];
            if (candidate === sourceTable.name.toLowerCase()) return null;
            const targetTable = tableMap[candidate];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = findPKColumn(targetTable);
                if (targetCol) {
                    return makeRel(sourceTable.name, colName, targetTable.name, targetCol.name);
                }
            }
        }

        // Pattern 5: {TableName}_Ref, {TableName}Ref
        match = colLower.match(/^(.+?)_?ref$/);
        if (match) {
            const candidate = match[1];
            const targetTable = tableMap[candidate];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = findPKColumn(targetTable);
                if (targetCol) {
                    return makeRel(sourceTable.name, colName, targetTable.name, targetCol.name);
                }
            }
        }

        // Pattern 6: Exact column name match with another table's PK
        for (const otherTable of allTables) {
            if (otherTable.name === sourceTable.name) continue;
            for (const otherCol of otherTable.columns) {
                if (otherCol.isPK && otherCol.name.toLowerCase() === colLower) {
                    return makeRel(sourceTable.name, colName, otherTable.name, otherCol.name);
                }
            }
        }

        // Pattern 7: Column named {TableName}_{ColumnName} -> Table.Column
        match = colName.match(/^(.+?)_(.+)$/);
        if (match) {
            const tablePart = match[1].toLowerCase();
            const colPart = match[2].toLowerCase();
            const targetTable = tableMap[tablePart];
            if (targetTable && targetTable.name !== sourceTable.name) {
                const targetCol = targetTable.columns.find(c =>
                    c.name.toLowerCase() === colPart
                );
                if (targetCol) {
                    return makeRel(sourceTable.name, colName, targetTable.name, targetCol.name);
                }
            }
        }

        // Pattern 8: Column name contains a table name (broader match)
        for (const otherTable of allTables) {
            if (otherTable.name === sourceTable.name) continue;
            const otherLower = otherTable.name.toLowerCase();
            const otherSingular = singularize(otherLower);

            // Check if column starts with table name and ends with id/key/code/ref/num/no
            if (colLower.startsWith(otherLower) || colLower.startsWith(otherSingular)) {
                const suffix = colLower.startsWith(otherLower)
                    ? colLower.slice(otherLower.length).replace(/^_/, '')
                    : colLower.slice(otherSingular.length).replace(/^_/, '');

                if (['id', 'key', 'code', 'ref', 'num', 'no', 'number', 'fk'].includes(suffix)) {
                    const targetCol = findPKColumn(otherTable);
                    if (targetCol) {
                        return makeRel(sourceTable.name, colName, otherTable.name, targetCol.name);
                    }
                }
            }
        }

        return null;
    }

    function makeRel(fromTable, fromColumn, toTable, toColumn) {
        return {
            id: generateId(),
            fromTable,
            fromColumn,
            toTable,
            toColumn,
            type: '1:N',
            method: 'name-pattern'
        };
    }

    /**
     * Find the PK column of a table
     */
    function findPKColumn(table) {
        // Check for marked PK
        let pk = table.columns.find(c => c.isPK);
        if (pk) return pk;

        // Check for column named "Id"
        pk = table.columns.find(c => /^id$/i.test(c.name.trim()));
        if (pk) return pk;

        // {TableName}Id
        const tLower = table.name.toLowerCase();
        pk = table.columns.find(c => c.name.toLowerCase() === tLower + 'id');
        if (pk) return pk;

        // {TableName}_Id
        pk = table.columns.find(c => c.name.toLowerCase() === tLower + '_id');
        if (pk) return pk;

        // Singular form
        const singular = singularize(tLower);
        pk = table.columns.find(c => c.name.toLowerCase() === singular + 'id' || c.name.toLowerCase() === singular + '_id');
        if (pk) return pk;

        // Any column ending in "id"
        pk = table.columns.find(c => /id$/i.test(c.name.trim()));
        if (pk) return pk;

        // First column as fallback
        return table.columns[0] || null;
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

    /**
     * Create a manual relationship
     */
    function createManual(fromTable, fromColumn, toTable, toColumn, type) {
        return {
            id: generateId(),
            fromTable,
            fromColumn,
            toTable,
            toColumn,
            type: type || '1:N',
            method: 'manual'
        };
    }

    return { detect, deepScan, createManual };
})();
