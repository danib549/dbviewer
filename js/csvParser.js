/**
 * CSV Parser Module
 * Parses CSV files and extracts table metadata (columns, types, PK candidates)
 */
const CsvParser = (() => {

    /**
     * Parse a single CSV file and return a table object
     * @param {File} file
     * @returns {Promise<Object>} table object
     */
    function parseFile(file) {
        return new Promise((resolve, reject) => {
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                dynamicTyping: false,
                complete: (results) => {
                    const tableName = extractTableName(file.name);
                    const columns = analyzeColumns(results.meta.fields || [], results.data);
                    resolve({
                        name: tableName,
                        fileName: file.name,
                        columns: columns,
                        data: results.data,
                        rowCount: results.data.length,
                    });
                },
                error: (err) => {
                    reject(new Error(`Failed to parse ${file.name}: ${err.message}`));
                }
            });
        });
    }

    /**
     * Parse multiple CSV files
     * @param {FileList|File[]} files
     * @returns {Promise<Object[]>} array of table objects
     */
    async function parseFiles(files) {
        const promises = Array.from(files).map(f => parseFile(f));
        return Promise.all(promises);
    }

    /**
     * Extract table name from filename
     * Handles: TableName.csv, dbo.TableName.csv, schema.TableName.csv
     */
    function extractTableName(fileName) {
        let name = fileName.replace(/\.csv$/i, '');
        // Remove schema prefix if present (e.g., "dbo.Orders" -> "Orders")
        const parts = name.split('.');
        if (parts.length > 1) {
            name = parts[parts.length - 1];
        }
        // Remove common prefixes
        name = name.replace(/^tbl_?/i, '');
        return name;
    }

    /**
     * Analyze columns: detect types and PK candidates
     */
    function analyzeColumns(fields, data) {
        return fields.map(field => {
            const type = detectType(field, data);
            const isPK = isPrimaryKeyCandidate(field);
            return {
                name: field,
                type: type,
                isPK: isPK,
                isFK: false, // Will be set by RelationshipDetector
            };
        });
    }

    /**
     * Detect column data type by sampling values
     */
    function detectType(columnName, data) {
        const sampleSize = Math.min(data.length, 100);
        let intCount = 0, floatCount = 0, boolCount = 0, dateCount = 0, emptyCount = 0;
        const total = sampleSize;

        for (let i = 0; i < sampleSize; i++) {
            const val = (data[i][columnName] || '').toString().trim();

            if (val === '' || val === 'NULL' || val === 'null') {
                emptyCount++;
                continue;
            }

            if (val === '0' || val === '1' || val.toLowerCase() === 'true' || val.toLowerCase() === 'false') {
                boolCount++;
            }

            if (/^-?\d+$/.test(val)) {
                intCount++;
            } else if (/^-?\d+\.\d+$/.test(val)) {
                floatCount++;
            }

            if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(val) || /^\d{2}[-/]\d{2}[-/]\d{4}/.test(val)) {
                dateCount++;
            }
        }

        const nonEmpty = total - emptyCount;
        if (nonEmpty === 0) return 'varchar';

        const threshold = 0.8;

        if (dateCount / nonEmpty >= threshold) return 'datetime';
        if (boolCount / nonEmpty >= threshold && intCount / nonEmpty >= threshold) {
            // Could be bit or int - check if only 0/1
            const allBinary = data.slice(0, sampleSize).every(row => {
                const v = (row[columnName] || '').toString().trim();
                return v === '' || v === '0' || v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'false' || v === 'NULL';
            });
            if (allBinary) return 'bit';
        }
        if (intCount / nonEmpty >= threshold) return 'int';
        if ((intCount + floatCount) / nonEmpty >= threshold) return 'decimal';

        // Check max length for varchar vs nvarchar hint
        let maxLen = 0;
        for (let i = 0; i < sampleSize; i++) {
            const len = (data[i][columnName] || '').length;
            if (len > maxLen) maxLen = len;
        }

        if (maxLen > 255) return 'text';
        return 'varchar';
    }

    /**
     * Check if column name suggests it's a primary key
     */
    function isPrimaryKeyCandidate(columnName) {
        const name = columnName.trim();
        // Exact match "Id" or "ID"
        if (/^[Ii][Dd]$/.test(name)) return true;
        // Ends with _ID or _Id (but not things like CustomerId which are FKs)
        // Only consider it PK if it's just "Id" by itself
        if (/^PK_/i.test(name)) return true;
        // {TableName}Id pattern is more likely FK, not PK
        // So we only mark simple "Id" as PK candidate
        return false;
    }

    return { parseFile, parseFiles, extractTableName };
})();
