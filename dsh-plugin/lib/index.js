/**
 * Package entry of the `dsh-plugin-deskpilot` profile bundle.
 *
 * This is the module a bundle row's `name` resolves to, and the Cordis loader
 * unwraps a plugin's exports from here (`exports.default ?? exports`), so the
 * plugin object — `name`, `inject`, `Config`, `apply` — has to be re-exported
 * from the module the package points at. It lives in `plugin.js` so the
 * implementation reads as one file; this entry exists to publish it.
 *
 * @module dsh-plugin-deskpilot
 */
export { apply, Config, inject, name } from './plugin.js'

