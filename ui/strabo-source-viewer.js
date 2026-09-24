/**
 * The Source window: a file's content or a change's diff, read by path through `/source`
 * and `/diff`. A late response is dropped when the viewer has moved on to another target.
 */

import { renderSource } from './strabo-panels.js';

export function createSourceViewer(app) {
  const { state, elements } = app;

  /** The viewer's current target: the file, the two sides, and what has been fetched. */
  let sourceView = null;

  /** Open the viewer on a file, at `line` when given. A `diffSpec` opens it on the change. */
  function viewSource(file, options = {}) {
    sourceView = {
      file,
      ref: options.ref ?? null,
      line: options.line ?? null,
      status: options.status ?? null,
      diffSpec: options.diffSpec ?? null,
      hasDiff: Boolean(options.diffSpec),
      mode: options.diffSpec ? 'diff' : 'content',
      loading: true,
      error: null,
      content: null,
      diff: null,
    };
    app.floatingWindows.find((controller) => controller.key === 'source')?.open();
    loadSource(sourceView.mode).catch(() => {});
  }

  /** Open the viewer straight on a change; `spec` names the two sides for `/diff`. */
  function viewDiff(file, spec, options = {}) {
    viewSource(file, { ...options, diffSpec: spec });
  }

  /** Fetch the side the viewer is showing; a late response is dropped if the target moved. */
  async function loadSource(mode) {
    const target = sourceView;
    if (!target) {
      return;
    }
    target.mode = mode;
    target.loading = true;
    target.error = null;
    sourceRender();
    const query = new URLSearchParams({ file: target.file });
    if (state.repository) {
      query.set('repository', state.repository);
    }
    try {
      if (mode === 'diff') {
        for (const [key, value] of Object.entries(target.diffSpec ?? {})) {
          query.set(key, String(value));
        }
        const body = await app.request(`/diff?${query.toString()}`);
        if (sourceView !== target) return;
        if (body.available === false) target.error = body.detail ?? body.reason;
        else target.diff = body.diff;
      } else {
        if (target.ref) query.set('ref', target.ref);
        const body = await app.request(`/source?${query.toString()}`);
        if (sourceView !== target) return;
        target.content = body.content;
      }
    } catch (error) {
      if (sourceView !== target) return;
      target.error = error.message;
    } finally {
      if (sourceView === target) {
        target.loading = false;
        sourceRender();
      }
    }
  }

  function sourceRender() {
    if (!sourceView) {
      return;
    }
    renderSource(elements.sourcePanel, sourceView, {
      onClose: () => app.floatingWindows.find((controller) => controller.key === 'source')?.close(),
      onShowFile: sourceView.hasDiff && sourceView.mode === 'diff' ? () => loadSource('content') : null,
      onShowDiff: sourceView.hasDiff && sourceView.mode === 'content' ? () => loadSource('diff') : null,
    });
  }

  /** Whether the viewer has a file to reopen. */
  function hasSourceTarget() {
    return Boolean(sourceView);
  }

  /** Clear the panel but keep the target, so the dock chip can reopen the last file. */
  function closeSource() {
    elements.sourcePanel.hidden = true;
    elements.sourcePanel.replaceChildren();
  }

  /**
   * The Terminal's `openSourceAt` hook: show a repo-relative file at a line from a clicked
   * `path:line` citation. The viewer reads by path directly (`/source?file=`), so a file that
   * is not a node on the current map still opens; when it is a node, the map selection follows
   * the citation too. The viewer has no load callback, so poll briefly for the marked row.
   */
  function openSourceAt(file, line) {
    const target = typeof file === 'string' ? file.replace(/\\/g, '/') : '';
    if (!target) {
      return;
    }
    app.setScreen('graph');
    const node = (app.current?.nodes ?? []).find((candidate) => candidate.id === target);
    if (node) {
      app.selectNode(node.id);
    }
    const lineNumber = Number.isInteger(line) && line > 0 ? line : null;
    viewSource(node?.id ?? target, { line: lineNumber });
    if (lineNumber) {
      revealSourceLine();
    }
  }

  /** Bring the marked line into view once the async source fetch has rendered it. */
  function revealSourceLine(attempt = 0) {
    const marked = elements.sourcePanel?.querySelector('.src-mark');
    if (marked) {
      marked.scrollIntoView?.({ block: 'center' });
      return;
    }
    if (attempt < 20) {
      setTimeout(() => revealSourceLine(attempt + 1), 50);
    }
  }

  return {
    closeSource,
    hasSourceTarget,
    openSourceAt,
    sourceRender,
    viewDiff,
    viewSource,
  };
}
