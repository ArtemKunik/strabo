import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';

import { resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/** Agents the delegate endpoint may launch. Anything else is rejected, never executed. */
const ALLOWED_AGENTS = ['opencode', 'claude'] as const;

export type DelegateAgent = (typeof ALLOWED_AGENTS)[number];

/** Prompt ceiling keeps the request under the 1mb JSON body limit with room to spare. */
const MAX_PROMPT_CHARS = 60000;

export interface DelegateRun {
  id: string;
  agent: DelegateAgent;
  target: { kind: string; id?: string; label?: string };
  repository: string;
  title: string;
  promptFile: string;
  launcher: string;
  createdAt: string;
  status: 'launched' | 'dry-run';
}

/** Recent launches, newest first. Terminals outlive the server, so this is a log, not supervision. */
const runs: DelegateRun[] = [];

function record(run: DelegateRun): void {
  runs.unshift(run);
  if (runs.length > 50) {
    runs.length = 50;
  }
}

function toForwardSlashes(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * A `.cmd` launcher keeps quoting in one controlled place; user text only ever lands in
 * the prompt file.
 *
 * Both CLIs take the message as a variadic positional (`opencode run [message..]`;
 * Claude's prompt argument), and both take the file/directory flag as a variadic option
 * (`-f/--file <files...>`; `--add-dir <directories...>`). A variadic option greedily
 * consumes every following bare token, not just the one meant for it — so
 * `-f "<path>" "<message>"` hands the CLI a *two-element* file array (the real path, then
 * the entire message treated as a second, nonexistent path) and an *empty* message,
 * which is exactly the "File not found: <the whole message>" this shipped with.
 * Confirmed against the installed opencode 1.18.30 and Claude Code CLIs. The message
 * must come first so the variadic flag has nothing left to swallow.
 */
function launcherScript(agent: DelegateAgent, root: string, promptFile: string, workDir: string): string {
  const header = ['@echo off', 'chcp 65001 >nul', `cd /d "${root}"`];
  if (agent === 'opencode') {
    return [
      ...header,
      `opencode run --dir "${root}" "The task is described in the attached file. Read it and carry it out in this repository (${root})." -f "${promptFile}"`,
    ].join('\r\n');
  }
  return [
    ...header,
    `claude "The task is described in @${toForwardSlashes(promptFile)}. Read it and carry it out in this repository (${root})." --add-dir "${toForwardSlashes(workDir)}"`,
  ].join('\r\n');
}

/**
 * Open a new terminal window running an agent on a delegated item.
 *
 * POST /delegate { agent, repository?, target?, prompt?, title?, dryRun? }
 * The prompt is written to a temp file and referenced from a generated launcher
 * script, so delegated text is never interpreted as a shell command. The working
 * directory is the repository root, resolved through the scan ceiling.
 */
export function createDelegateRouter(config: StraboConfig): Router {
  const router = Router();

  router.post('/delegate', (request, response) => {
    try {
      const agent = request.body?.agent;
      if (!ALLOWED_AGENTS.includes(agent)) {
        response.status(400).json({ error: 'agent must be one of: opencode, claude.' });
        return;
      }
      const prompt = request.body?.prompt;
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        response.status(400).json({ error: 'prompt is required.' });
        return;
      }
      if (prompt.length > MAX_PROMPT_CHARS) {
        response.status(413).json({ error: `prompt exceeds ${MAX_PROMPT_CHARS} characters.` });
        return;
      }
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: config.scanCeiling ?? config.workspaceRoot,
        requested: typeof request.body?.repository === 'string' ? request.body.repository : undefined,
      });
      const rawTarget = request.body?.target;
      const target = {
        kind: typeof rawTarget?.kind === 'string' ? rawTarget.kind : 'view',
        ...(typeof rawTarget?.id === 'string' ? { id: rawTarget.id } : {}),
        ...(typeof rawTarget?.label === 'string' ? { label: rawTarget.label } : {}),
      };
      const title =
        typeof request.body?.title === 'string' && request.body.title.trim() !== ''
          ? request.body.title.trim().slice(0, 80)
          : (target.label ?? target.id ?? 'repository view');

      const id = randomUUID();
      const workDir = path.join(os.tmpdir(), 'strabo-delegate', id);
      fs.mkdirSync(workDir, { recursive: true });
      const promptFile = path.join(workDir, 'strabo-task.md');
      fs.writeFileSync(promptFile, `${prompt.trim()}\n`, 'utf8');
      const launcher = path.join(workDir, `launch-${agent}.cmd`);
      fs.writeFileSync(launcher, launcherScript(agent, repository.root, promptFile, workDir), 'utf8');

      if (request.body?.dryRun === true) {
        const run: DelegateRun = {
          id,
          agent,
          target,
          repository: repository.root,
          title,
          promptFile,
          launcher,
          createdAt: new Date().toISOString(),
          status: 'dry-run',
        };
        record(run);
        response.status(201).json({ ...run, command: fs.readFileSync(launcher, 'utf8') });
        return;
      }

      if (process.platform !== 'win32') {
        response.status(501).json({ error: 'Terminal launch is only supported on Windows.' });
        return;
      }
      const child = spawn(
        'cmd.exe',
        ['/d', '/s', '/c', 'start', `Strabo ${agent} ${id.slice(0, 8)}`, '/D', repository.root, launcher],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      const run: DelegateRun = {
        id,
        agent,
        target,
        repository: repository.root,
        title,
        promptFile,
        launcher,
        createdAt: new Date().toISOString(),
        status: 'launched',
      };
      record(run);
      response.status(201).json(run);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/delegate', (_request, response) => {
    response.json({ runs });
  });

  router.get('/delegate/:id', (request, response) => {
    const run = runs.find((entry) => entry.id === request.params.id);
    if (!run) {
      response.status(404).json({ error: 'Unknown delegate run.' });
      return;
    }
    response.json(run);
  });

  return router;
}
