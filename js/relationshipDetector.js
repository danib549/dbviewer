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
     * Deep scan: detect relationships using multi-signal confidence scoring.
     * Analyzes data values, types, NULL patterns, and cardinality.
     * @param {Object[]} tables
     * @param {Object[]} existingRels
     * @returns {Object[]} new relationships found
     */
    function deepScan(tables, existingRels) {
        const newRels = [];
        const allRels = [...existingRels];

        for (const table of tables) {
            markPrimaryKeys(table);
        }

        // Pre-compute column stats for all tables
        const statsCache = {};
        for (const table of tables) {
            statsCache[table.name] = {};
            for (const col of table.columns) {
                statsCache[table.name][col.name] = analyzeColumnStats(table.data, col.name);
            }
        }

        for (const srcTable of tables) {
            for (const srcCol of srcTable.columns) {
                if (srcCol.isPK) continue;
                // Skip types that are never FKs
                if (srcCol.type === 'datetime' || srcCol.type === 'text' || srcCol.type === 'bit') continue;

                const srcStats = statsCache[srcTable.name][srcCol.name];
                if (srcStats.uniqueValues.size < 2) continue;

                for (const tgtTable of tables) {
                    if (tgtTable.name === srcTable.name) continue;

                    for (const tgtCol of tgtTable.columns) {
                        const testRel = {
                            fromTable: srcTable.name, fromColumn: srcCol.name,
                            toTable: tgtTable.name, toColumn: tgtCol.name
                        };
                        if (isDuplicate(allRels, testRel)) continue;

                        const tgtStats = statsCache[tgtTable.name][tgtCol.name];
                        if (tgtStats.uniqueValues.size < 2) continue;

                        // === Multi-signal scoring ===
                        const score = scoreRelationship(srcCol, tgtCol, srcStats, tgtStats, srcTable, tgtTable);

                        if (score >= 0.55) {
                            const srcUniqueRatio = srcStats.uniqueValues.size / Math.max(srcTable.data.length, 1);
                            const rel = {
                                id: generateId(),
                                fromTable: srcTable.name,
                                fromColumn: srcCol.name,
                                toTable: tgtTable.name,
                                toColumn: tgtCol.name,
                                type: srcUniqueRatio > 0.9 ? '1:1' : '1:N',
                                confidence: Math.round(score * 100),
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

        // Sort by confidence descending and return
        newRels.sort((a, b) => b.confidence - a.confidence);
        return newRels;
    }

    /**
     * Analyze column statistics for scoring
     */
    function analyzeColumnStats(data, colName) {
        const values = new Set();
        let nullCount = 0;
        let totalCount = 0;
        const sampleSize = Math.min(data.length, 500);

        for (let i = 0; i < sampleSize; i++) {
            totalCount++;
            const val = (data[i][colName] || '').toString().trim();
            if (!val || val === 'NULL' || val === 'null' || val === '') {
                nullCount++;
            } else {
                values.add(val);
            }
        }

        return {
            uniqueValues: values,
            nullCount: nullCount,
            nullRatio: nullCount / Math.max(totalCount, 1),
            uniqueRatio: values.size / Math.max(totalCount - nullCount, 1),
            totalSampled: totalCount,
        };
    }

    /**
     * Multi-signal confidence scoring for a potential FK relationship
     * Returns 0.0 - 1.0
     */
    function scoreRelationship(srcCol, tgtCol, srcStats, tgtStats, srcTable, tgtTable) {
        let score = 0;

        // === Signal 1: Value match ratio (40% weight) ===
        let matchCount = 0;
        for (const v of srcStats.uniqueValues) {
            if (tgtStats.uniqueValues.has(v)) matchCount++;
        }
        const matchRatio = matchCount / Math.max(srcStats.uniqueValues.size, 1);
        score += matchRatio * 0.40;

        // If no values match at all, skip
        if (matchCount < 2) return 0;

        // === Signal 2: Type compatibility (20% weight) ===
        const typeScore = getTypeCompatibility(srcCol.type, tgtCol.type);
        score += typeScore * 0.20;
        // If types are incompatible, heavily penalize
        if (typeScore === 0) return score * 0.3;

        // === Signal 3: Cardinality pattern (20% weight) ===
        // FK columns should have fewer unique values than the target PK column
        // (many rows point to fewer distinct target values)
        let cardScore = 0;
        if (tgtStats.uniqueRatio > 0.7) {
            // Target has high uniqueness (PK-like)
            cardScore += 0.5;
        }
        if (tgtCol.isPK) {
            cardScore += 0.3;
        }
        if (srcStats.uniqueRatio < tgtStats.uniqueRatio) {
            // Source has more repeated values than target (FK pattern)
            cardScore += 0.2;
        }
        score += Math.min(cardScore, 1) * 0.20;

        // === Signal 4: NULL pattern (10% weight) ===
        let nullScore = 0;
        // PK columns should have zero NULLs
        if (tgtStats.nullRatio === 0) nullScore += 0.5;
        // FK columns may have some NULLs (optional relationships)
        // but having zero NULLs is also fine
        if (srcStats.nullRatio <= 0.5) nullScore += 0.5;
        score += nullScore * 0.10;

        // === Signal 5: Column name hint (10% weight) ===
        let nameScore = 0;
        const srcLower = srcCol.name.toLowerCase();
        const tgtLower = tgtCol.name.toLowerCase();
        // Source column name contains 'id', 'key', 'code', 'ref', 'fk'
        if (/id$|_id$|key$|code$|ref$|^fk_/i.test(srcLower)) nameScore += 0.4;
        // Target column name looks like PK
        if (/^id$|_id$|key$|code$/i.test(tgtLower) || tgtCol.isPK) nameScore += 0.4;
        // Source contains target table name
        if (srcLower.includes(tgtTable.name.toLowerCase()) ||
            srcLower.includes(singularize(tgtTable.name.toLowerCase()))) {
            nameScore += 0.2;
        }
        score += Math.min(nameScore, 1) * 0.10;

        return Math.min(score, 1);
    }

    /**
     * Type compatibility check (0 = incompatible, 0.5 = partial, 1 = perfect match)
     */
    function getTypeCompatibility(srcType, tgtType) {
        if (srcType === tgtType) return 1;
        const groups = {
            numeric: ['int', 'decimal', 'bit'],
            text: ['varchar', 'text'],
            time: ['datetime'],
        };
        for (const types of Object.values(groups)) {
            if (types.includes(srcType) && types.includes(tgtType)) return 0.7;
        }
        // int/varchar can sometimes match (codes stored as strings)
        if ((srcType === 'int' && tgtType === 'varchar') ||
            (srcType === 'varchar' && tgtType === 'int')) return 0.3;
        return 0;
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
