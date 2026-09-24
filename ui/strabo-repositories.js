/**
 * Choosing the repository: the known-repository selector, remembering and forgetting a
 * root server-side, and the folder dialog that browses within the configured scan ceiling.
 */

import { API_PATH, folderLocation } from './strabo-core.js';
import { renderFolderList } from './strabo-panels.js';

export function createRepositoryPicker(app) {
  const { state, elements } = app;

  let browsedFolder = null;

  async function loadCatalogue() {
    const catalogue = await app.request('/repositories');
    renderRepositoryOptions(catalogue.repositories, catalogue.active);
  }

  /** Rebuild the repository selector from the known list, selecting the active one. */
  function renderRepositoryOptions(repositories, active) {
    elements.repository.replaceChildren(
      ...repositories.map((entry) => {
        const option = document.createElement('option');
        option.value = entry.root;
        option.textContent = entry.name;
        return option;
      }),
    );
    if (repositories.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No repositories';
      option.disabled = true;
      elements.repository.append(option);
    }
    const chosen = active ?? repositories[0]?.root ?? null;
    if (chosen) {
      elements.repository.value = chosen;
    }
    state.repository = elements.repository.value || null;
    elements.forget.disabled = !state.repository;
  }

  /** Remember a repository server-side so it is offered again after a restart. */
  async function rememberRepository(root) {
    const response = await fetch(`${API_PATH}/repositories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Could not remember ${root}`);
    }
    return response.json();
  }

  /** Folder selection is a server-side browse bounded by the configured scan ceiling. */
  async function loadFolder(path) {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const result = await app.request(`/browse${query}`);
    browsedFolder = result;
    const location = folderLocation(result);
    elements.folderPath.textContent = result.path;
    elements.folderNote.textContent = location.note;
    elements.folderNote.classList.toggle('at-ceiling', location.atCeiling);
    elements.folderUp.disabled = location.atCeiling;
    elements.folderUp.title = location.upLabel;
    elements.folderUp.dataset.parent = result.parent ?? '';
    renderFolderList(elements.folderList, result, (next) => {
      loadFolder(next).catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    });
  }

  function openFolderDialog() {
    browsedFolder = null;
    elements.folderDialog.showModal();
    loadFolder(state.repository ?? undefined).catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  }

  /** Point the app at a chosen repository, remembering it as the active one. */
  async function useRepository(path) {
    app.prefs.writeViewPrefs();
    state.repository = path;
    state.prefix = '';
    state.filter = '';
    elements.filter.value = '';

    try {
      await rememberRepository(path);
      const catalogue = await app.request('/repositories');
      renderRepositoryOptions(catalogue.repositories, path);
    } catch (error) {
      elements.status.textContent = `Error: ${error.message}`;
      return;
    }
    app.prefs.applyViewPrefs();
    app.scan();
  }

  /** Forget the selected repository; it stays usable until the page reloads. */
  async function forgetRepository() {
    const root = state.repository;
    if (!root) {
      return;
    }
    const response = await fetch(`${API_PATH}/repositories?root=${encodeURIComponent(root)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      elements.status.textContent = 'Error: could not forget the repository.';
      return;
    }
    const catalogue = await app.request('/repositories');
    renderRepositoryOptions(catalogue.repositories, catalogue.active);
    if (state.repository !== root) {
      app.scan();
    }
  }

  elements.repository.addEventListener('change', () => {
    const root = elements.repository.value;
    if (!root) {
      return;
    }
    // Save outgoing view settings before switching, then restore the new repo's.
    app.prefs.writeViewPrefs();
    state.repository = root;
    state.prefix = '';
    state.filter = '';
    elements.filter.value = '';
    elements.forget.disabled = false;
    app.prefs.applyViewPrefs();
    rememberRepository(root)
      .then(() => app.scan())
      .catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
  });

  elements.forget.addEventListener('click', () => {
    forgetRepository().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });

  elements.browse.addEventListener('click', openFolderDialog);

  elements.folderCancel.addEventListener('click', () => elements.folderDialog.close());

  elements.folderUp.addEventListener('click', () => {
    const parent = elements.folderUp.dataset.parent;
    if (parent) {
      loadFolder(parent).catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    }
  });

  elements.folderUse.addEventListener('click', () => {
    if (browsedFolder) {
      elements.folderDialog.close();
      useRepository(browsedFolder.path).catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    }
  });

  return {
    loadCatalogue,
  };
}
