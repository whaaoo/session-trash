/**
 * Package entry: re-exports the Host half. The Loader row imports the
 * `./route` subpath so a patched implementation loads as its own module
 * generation.
 */

export { apply, inject, name } from './route.js'
