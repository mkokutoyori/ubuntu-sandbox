/**
 * Supported SQL dialects.
 * Each DBMS extends the shared engine with dialect-specific behaviour.
 */
export type SQLDialect = 'oracle' | 'postgres' | 'mysql' | 'sqlserver';
