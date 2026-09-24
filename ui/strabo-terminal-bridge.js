/**
 * The Terminal screen's link to the map: its tab badge, the repository a new session opens
 * in, clicked `path:line` citations, and the read-only `::strabo::` control directives.
 */

import { setDelegateSessionOpener, showToast } from './strabo-delegate.js';
import { initTerminalScreen } from './strabo-terminal.js';

export function createTerminalBridge(app) {
  const { state, view, elements } = app;

  /** Whether an id names a node on the current map, so a control directive cannot point elsewhere. */
  function isMappedNode(id) {
    return Boolean(id) && (app.current?.nodes ?? []).some((candidate) => candidate.id === id);
  }

  /**
   * The Terminal's `onControl` hook: a `::strabo::` marker printed by the `strabo` shim on a
   * session's PATH becomes a read-only map action. The verbs are a fixed set and anything
   * unknown is ignored; node and file arguments are matched against the current map, so a
   * directive can never reach a path the source viewer would not already allow.
   */
  function handleTerminalControl(directive) {
    const verb = directive?.verb;
    const args = Array.isArray(directive?.args) ? directive.args : [];
    switch (verb) {
      case 'focus': {
        const id = args[0];
        if (isMappedNode(id)) {
          app.setScreen('graph');
          app.selection.selectNode(id);
        }
        return;
      }
      case 'open': {
        const file = args[0];
        const line = Number.parseInt(args[1] ?? '', 10);
        if (file) {
          app.source.openSourceAt(file, Number.isInteger(line) ? line : null);
        }
        return;
      }
      case 'highlight': {
        const ids = args.filter(isMappedNode);
        if (ids.length > 0) {
          app.setScreen('graph');
          view.highlight(ids);
        }
        return;
      }
      case 'review': {
        app.setScreen('graph');
        const ref = args[0];
        const pending = ref
          ? app.git.showReview(`?base=${encodeURIComponent(ref)}`, { hash: ref })
          : app.git.showReview('');
        Promise.resolve(pending).catch((error) => {
          showToast(`Review failed (${error.message}).`);
        });
        return;
      }
      case 'note': {
        const message = args.join(' ').trim();
        if (message) {
          showToast(message);
        }
        return;
      }
      case 'screen': {
        const target = args[0];
        if (target === 'graph' || target === 'terminal') {
          app.setScreen(target);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * The Terminal screen. Created once at bootstrap — like the graph, it lives for the whole
   * page session, so switching tabs only shows/hides it rather than tearing it down.
   *
   * The tab badge is built here rather than in `index.html` (owned elsewhere); it reuses the
   * diagnostics pill classes, so it needs no new CSS and reports running/failed sessions even
   * while the Graph screen is showing.
   */
  const terminalBadge = document.createElement('span');

  terminalBadge.id = 'terminal-badge';

  terminalBadge.className = 'diag-badge';

  terminalBadge.hidden = true;

  elements.screenTabTerminal.append(terminalBadge);

  /** Show a count of running sessions on the tab, reddened when any session has failed. */
  function updateTerminalBadge(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    const running = list.filter((session) => session?.status === 'running').length;
    const failed = list.filter(
      (session) => session?.status === 'exited' && (session.exitCode ?? 0) !== 0,
    ).length;
    const count = running + failed;
    terminalBadge.hidden = count === 0;
    terminalBadge.textContent = String(count);
    terminalBadge.classList.toggle('has-errors', failed > 0);
    terminalBadge.title = failed > 0 ? `${running} running, ${failed} failed` : `${running} running`;
  }

  /** The active repository as `{ name, root }` for a new terminal session. */
  function resolveRepository() {
    const repository = app.current?.repository;
    const root = repository?.root ?? state.repository ?? null;
    const name = repository?.name ?? (root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null);
    return { name, root };
  }

  /** The Terminal's toast hook, accepting either a plain message or one carrying an action. */
  function terminalToast(message, options = {}) {
    return showToast(message, options.action ?? null, { timeout: options.timeout ?? 6000 });
  }

  app.terminalScreen = initTerminalScreen(elements.terminalContainer, {
    openSourceAt: (file, line) => app.source.openSourceAt(file, line),
    toast: terminalToast,
    onSessionsChanged: updateTerminalBadge,
    resolveRepository,
    closeTerminal: () => app.setScreen('graph'),
    onControl: handleTerminalControl,
  });

  // A delegated run is created server-side; this is how its session reaches the screen.
  setDelegateSessionOpener((sessionId) => {
    app.setScreen('terminal');
    return app.terminalScreen?.openSession?.(sessionId);
  });
}
