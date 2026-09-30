/**
 * The narrator-supported commit action.
 *
 * One dialog does the whole job: it asks the server to generate a commit message from
 * recorded facts, shows it for the operator to read and edit, and only when the operator
 * confirms does it post the working tree to be committed and pushed. Nothing is committed
 * until the message on screen is agreed, and the narrator is only ever asked to describe
 * what the scan recorded.
 *
 * The action is off by default (Settings → Commit) because it writes to the repository.
 */

import { API_PATH } from './strabo-core.js';
import { showToast } from './strabo-delegate.js';

/**
 * Ask the server to generate a commit message for the working tree. The evidence is built
 * server-side from the scan, so the browser cannot steer what is described. Resolves with
 * `{ available, message, model, cached }` or `{ available: false, reason, detail }`.
 */
export async function requestCommitMessage(repository) {
  const response = await fetch(`${API_PATH}/narrator/commit-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(repository ? { repository } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Could not generate a message (${response.status}).`);
  }
  return body;
}

/**
 * Commit the working tree and, unless `push` is false, push the current branch. The server
 * passes the message to Git as an argument, never a shell, and never force-pushes.
 */
export async function commitWorkingTree(repository, message, { push = true } = {}) {
  const response = await fetch(`${API_PATH}/analysis/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, push, ...(repository ? { repository } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Commit failed (${response.status}).`);
  }
  return body;
}

let dialog = null;
let context = null;

function ensureDialog() {
  if (dialog) {
    return dialog;
  }
  const element = document.createElement('dialog');
  element.id = 'commit-dialog';
  element.className = 'dialog prompt-dialog commit-dialog';
  element.setAttribute('aria-label', 'Review the commit message before committing');

  const header = document.createElement('header');
  header.className = 'dialog-header';
  const heading = document.createElement('strong');
  heading.className = 'commit-dialog-title';
  heading.textContent = 'Commit changes';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dialog-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => element.close());
  header.append(heading, close);

  const target = document.createElement('p');
  target.className = 'dialog-path prompt-dialog-target';

  const status = document.createElement('p');
  status.className = 'dialog-note commit-status';
  status.setAttribute('role', 'status');

  const text = document.createElement('textarea');
  text.className = 'prompt-dialog-text commit-message';
  text.spellcheck = false;
  text.setAttribute('aria-label', 'Commit message');

  const footer = document.createElement('footer');
  footer.className = 'dialog-footer';

  const generate = document.createElement('button');
  generate.type = 'button';
  generate.className = 'commit-generate';
  generate.textContent = 'Generate again';
  generate.addEventListener('click', () => void generateMessage());

  const pushLabel = document.createElement('label');
  pushLabel.className = 'commit-push';
  const pushToggle = document.createElement('input');
  pushToggle.type = 'checkbox';
  pushToggle.checked = true;
  pushToggle.className = 'commit-push-toggle';
  pushLabel.append(pushToggle, document.createTextNode('Push after commit'));

  const left = document.createElement('span');
  left.className = 'commit-footer-left';
  left.append(generate, pushLabel);

  const actions = document.createElement('span');
  actions.className = 'dialog-footer-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => element.close());
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'primary commit-confirm';
  confirm.textContent = 'Commit & push';
  confirm.addEventListener('click', () => void submit());
  actions.append(cancel, confirm);

  footer.append(left, actions);
  element.append(header, target, status, text, footer);
  document.body.append(element);
  dialog = element;
  return element;
}

async function generateMessage() {
  if (!dialog || !context) {
    return;
  }
  const text = dialog.querySelector('.commit-message');
  const status = dialog.querySelector('.commit-status');
  const generate = dialog.querySelector('.commit-generate');
  const confirm = dialog.querySelector('.commit-confirm');
  generate.disabled = true;
  confirm.disabled = true;
  status.classList.remove('is-error');
  status.textContent = 'Generating a message with the narrator…';
  try {
    const result = await requestCommitMessage(context.repository);
    if (result?.available && typeof result.message === 'string' && result.message.trim() !== '') {
      text.value = result.message.trim();
      const model = result.model ?? 'the narrator';
      status.textContent = `Generated by ${model}${result.cached ? ' (cached)' : ''}. Review and edit before committing.`;
    } else {
      status.textContent = `Narrator unavailable (${result?.detail ?? result?.reason ?? 'not configured'}). Write a message, or set the narrator up in Settings.`;
      if (!text.value.trim()) {
        text.value = '';
      }
    }
  } catch (error) {
    status.textContent = error.message ?? 'Could not generate a message.';
    status.classList.add('is-error');
  } finally {
    generate.disabled = false;
    confirm.disabled = false;
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }
}

async function submit() {
  if (!dialog || !context) {
    return;
  }
  const text = dialog.querySelector('.commit-message');
  const status = dialog.querySelector('.commit-status');
  const generate = dialog.querySelector('.commit-generate');
  const confirm = dialog.querySelector('.commit-confirm');
  const push = dialog.querySelector('.commit-push-toggle')?.checked !== false;
  const message = text.value.trim();
  if (message === '') {
    status.classList.add('is-error');
    status.textContent = 'A commit message is required.';
    text.focus();
    return;
  }
  generate.disabled = true;
  confirm.disabled = true;
  status.classList.remove('is-error');
  status.textContent = push ? 'Committing and pushing…' : 'Committing…';
  try {
    const result = await commitWorkingTree(context.repository, message, { push });
    if (!result?.available) {
      status.classList.add('is-error');
      status.textContent = result?.detail ?? 'The commit did not run.';
      return;
    }
    showToast(result.message);
    dialog.close();
    context.onCommitted?.(result);
  } catch (error) {
    status.classList.add('is-error');
    status.textContent = error.message ?? 'The commit did not run.';
  } finally {
    generate.disabled = false;
    confirm.disabled = false;
  }
}

/**
 * Open the commit dialog for a repository and generate a first message. `onCommitted` runs
 * after a successful commit so the caller can refresh the overlays it now has stale truth
 * for.
 */
export function openCommitDialog({ repository, onCommitted } = {}) {
  const element = ensureDialog();
  context = { repository: repository ?? null, onCommitted };
  element.querySelector('.prompt-dialog-target').textContent = repository
    ? `Working tree · ${repository}`
    : 'Working tree';
  element.querySelector('.commit-message').value = '';
  const status = element.querySelector('.commit-status');
  status.classList.remove('is-error');
  status.textContent = 'Generating a message with the narrator…';
  if (!element.open) {
    element.showModal();
  }
  void generateMessage();
}
