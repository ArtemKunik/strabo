/**
 * A tiny observable store for the browser app.
 *
 * The controller used to hold loose `let` variables and imperative state objects, and every
 * handler had to remember which render to call afterwards. This keeps state in one place and
 * lets subscribers — renderers and the URL sync — react to a named slice changing instead of
 * being called by hand from each handler.
 *
 * `set` merges a patch into a slice in place, so code holding a reference to a slice keeps
 * working; `commit` notifies without changing anything, for mutations made through such a
 * reference. A listener receives the whole state and which slices changed. This is a state
 * container, not a framework: no immutability, no scheduler, no lifecycle.
 */
export function createStore(initial) {
  const state = initial;
  const listeners = new Set();

  function notify(changed) {
    for (const listener of [...listeners]) {
      listener(state, changed);
    }
  }

  return {
    get: () => state,

    /** Merge `patch` (an object or a function of the slice) into a slice, then notify. */
    set(slice, patch) {
      const target = state[slice];
      if (!target) {
        throw new Error(`Unknown store slice "${String(slice)}".`);
      }
      const changes = typeof patch === 'function' ? patch(target) : patch;
      if (changes) {
        Object.assign(target, changes);
      }
      notify({ [slice]: true });
    },

    /** Notify subscribers about a slice mutated directly; no state is changed here. */
    commit(slice) {
      notify(slice === undefined ? { all: true } : { [slice]: true });
    },

    /** Subscribe to changes. Returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
