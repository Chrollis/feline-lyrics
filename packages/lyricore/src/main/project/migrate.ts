/**
 * One step per version: `MIGRATIONS[v]` upgrades a `v` document to `v + 1`.
 *
 * Migrations take the RAW parsed value, not a built document, because the old
 * key set is the one that has to be understood: validating a v1 file against the
 * v2 key set first would reject every file the migration exists to rescue.
 *
 * The table is empty at v1 and that is the point: there is nothing older to
 * upgrade, and a version below 1 is not a version at all.
 */
export type ProjectMigration = (
    value: Record<string, unknown>,
) => Record<string, unknown>;

export const MIGRATIONS: readonly ProjectMigration[] = [];
