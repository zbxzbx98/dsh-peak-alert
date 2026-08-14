/**
 * dsh-peak-alert node half — inert by design: the plugin is pure client-side
 * (the peak/off-peak chip renders in the browser from the Beijing-time
 * schedule). This no-op host entry keeps the row a valid dual-face plugin so
 * the client-modules scanner picks up `exports["./client"]` via the
 * package.json dsh.client declaration.
 * @module dsh-peak-alert
 */

/** No host services required. */
const inject = [];

/**
 * No-op host apply: everything happens in the browser half.
 * @param ctx - host context (unused).
 */
function apply(ctx) {
	// Intentionally empty: client-only plugin.
}

export { apply, inject };
