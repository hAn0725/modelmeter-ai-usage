/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Importer logic version.
 *
 * Bump this whenever the session-extraction logic changes in a way that
 * requires re-parsing files that were already imported (for example: a field
 * was previously not extracted, or its semantics changed). Files recorded in
 * `processed_files` with an older version are automatically re-imported by the
 * background importer, which heals stale columns without a full DB rebuild.
 *
 * History:
 *   1 — initial version (size-based change detection only)
 *   2 — edited_file_count now merges `editedFileEvents` with applied
 *       `response[].textEditGroup` edits (previously only editedFileEvents
 *       were counted, leaving most turns at 0 despite real edits).
 */
export const IMPORTER_VERSION = 2;
