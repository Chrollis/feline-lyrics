import { LyricoreError } from '../errors.js';
import type { Lyrics } from '../lyrics/lyrics.js';
import {
    lyricsToProject,
    projectToLyrics,
    type ProjectFile,
    type ProjectRead,
} from './document.js';

/**
 * The project document as text.
 *
 * This module is the text layer and nothing else: the zip and the unzip of the
 * overlay array live in `document.ts`, and the shape is validated there. What
 * is here is one indentation rule, so a write -> read -> write cycle is stable
 * by construction.
 */
export function projectToJson(file: ProjectFile): string {
    return `${JSON.stringify(file, null, 4)}\n`;
}

export function lyricsToProjectJson(lyrics: Lyrics): string {
    return projectToJson(lyricsToProject(lyrics));
}

/**
 * Parse and validate a project document.
 *
 * A syntax error and a schema error are the same failure to a caller - the file
 * cannot be used - so both raise `invalid-project-file`, and the message says
 * which of the two it was.
 */
export function readProjectJson(text: string): ProjectRead {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new LyricoreError(
            'invalid-project-file',
            `the text is not JSON: ${reason}`,
            { expected: 'a JSON document', actual: reason },
        );
    }
    return projectToLyrics(value);
}
