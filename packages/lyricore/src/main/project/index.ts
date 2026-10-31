/**
 * The `.flrc` project document: the lyrics block plus the layers that are not
 * lyrics - the style book, the per-line overlay and the animation list.
 *
 * The lyrics block inside a project file is the FROZEN export, written and read
 * by `../lyrics/file.js`, and re-exported here for convenience: a project is a
 * wrapper around that block, never a second dialect of it.
 */

export * from './document.js';
export * from './json.js';
export * from './migrate.js';
