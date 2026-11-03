/**
 * Host half of the file-pane plugin.
 *
 * The whole feature lives in the browser bundle: the right Sidebar's pane
 * routing is client state. The host row stays empty so the Loader has a
 * package to activate and the client module graph can be composed from the
 * same package.
 */

export const name = 'file-pane'
export const inject = []

/** No host-side behavior. */
export function apply() {}
