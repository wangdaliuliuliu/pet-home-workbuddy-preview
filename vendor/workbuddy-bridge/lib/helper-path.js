/**
 * Absolute path of the standalone database helper.
 *
 * The plugin passes it to a plain Node.js binary only when `node:sqlite` is not
 * available in-process, so the session list keeps working either way.
 */
import { fileURLToPath } from 'node:url'

const helperPath = fileURLToPath(new URL('./db-read.mjs', import.meta.url))

export default helperPath
