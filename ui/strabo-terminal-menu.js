/**
 * The terminal's own right-click menu model.
 *
 * The app-wide context menu is about delegation: it lists "Delegate to …" and "Copy prompt"
 * entries that make no sense over a terminal and leave no way to paste. The terminal shows
 * this small clipboard menu instead. The model is pure so it can be unit-tested;
 * `strabo-terminal.js` attaches the xterm calls.
 */

/**
 * Items for the terminal context menu. `hasSelection` gates Copy: without a selection the
 * entry stays in the menu but inactive, with `title` explaining why. Each actionable item
 * carries an `id` the handler maps to an xterm call; a separator has none.
 */
export function terminalMenuItems({ hasSelection = false } = {}) {
  return [
    {
      id: 'copy',
      label: '⧉ Copy',
      hint: 'selection',
      ...(hasSelection ? {} : { title: 'Select text in the terminal first' }),
    },
    { id: 'paste', label: '⤓ Paste', hint: 'clipboard' },
    { separator: true },
    { id: 'select-all', label: 'Select all' },
  ];
}
