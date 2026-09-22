import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type PdfResult = { ok: true } | { ok: false; reason: string };

interface PlaywrightPage {
  setContent(html: string, options?: unknown): Promise<void>;
  pdf(options: unknown): Promise<unknown>;
}
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightChromium {
  launch(): Promise<PlaywrightBrowser>;
}

/**
 * Render the report HTML to PDF through a headless Chromium, or name why it could not.
 *
 * The HTML is the source of truth: this only prints it. A local `playwright` install is used
 * first; when it is absent (it is a dev dependency, not shipped) a system Edge/Chrome is
 * tried. If neither is found the caller keeps the HTML and reports the reason, so a missing
 * renderer is a named limitation, never a silent empty file.
 */
export async function renderReportPdf(html: string, outFile: string): Promise<PdfResult> {
  const playwright = await renderWithPlaywright(html, outFile);
  if (playwright.ok) {
    return playwright;
  }
  const browser = await renderWithSystemBrowser(html, outFile);
  if (browser.ok) {
    return browser;
  }
  return { ok: false, reason: `${playwright.reason}; ${browser.reason}` };
}

async function renderWithPlaywright(html: string, outFile: string): Promise<PdfResult> {
  let chromium: PlaywrightChromium | undefined;
  try {
    // A variable specifier keeps this an optional, runtime-only dependency: the shipped
    // package does not depend on playwright, and nothing loads until a PDF is requested.
    const moduleName = 'playwright';
    const loaded = (await import(moduleName)) as { chromium?: PlaywrightChromium };
    chromium = loaded.chromium;
  } catch (error) {
    return { ok: false, reason: `playwright unavailable (${firstLine(error)})` };
  }
  if (!chromium) {
    return { ok: false, reason: 'playwright has no chromium export' };
  }
  let browser: PlaywrightBrowser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: outFile, format: 'A4', printBackground: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `playwright render failed (${firstLine(error)})` };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function renderWithSystemBrowser(html: string, outFile: string): Promise<PdfResult> {
  const candidates = browserCandidates();
  if (candidates.length === 0) {
    return { ok: false, reason: 'no headless browser found' };
  }
  const htmlFile = path.join(os.tmpdir(), `strabo-report-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(htmlFile, html, 'utf8');
  const failures: string[] = [];
  try {
    for (const executable of candidates) {
      try {
        await run(
          executable,
          [
            '--headless=new',
            '--disable-gpu',
            '--no-pdf-header-footer',
            `--print-to-pdf=${outFile}`,
            pathToFileURL(htmlFile).href,
          ],
          { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        );
        if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
          return { ok: true };
        }
        failures.push(`${executable}: no output`);
      } catch (error) {
        failures.push(`${executable}: ${firstLine(error)}`);
      }
    }
  } finally {
    fs.rmSync(htmlFile, { force: true });
  }
  return { ok: false, reason: failures.join('; ') };
}

function browserCandidates(): string[] {
  const fromEnv = (name: string): string | undefined => process.env[name];
  const existing = (candidates: Array<string | undefined>): string[] =>
    candidates.filter((candidate): candidate is string => Boolean(candidate) && fs.existsSync(candidate as string));

  if (process.platform === 'win32') {
    return [
      ...existing([
        fromEnv('PROGRAMFILES') && path.join(fromEnv('PROGRAMFILES') as string, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        fromEnv('PROGRAMFILES(X86)') && path.join(fromEnv('PROGRAMFILES(X86)') as string, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        fromEnv('PROGRAMFILES') && path.join(fromEnv('PROGRAMFILES') as string, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        fromEnv('PROGRAMFILES(X86)') && path.join(fromEnv('PROGRAMFILES(X86)') as string, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        fromEnv('LOCALAPPDATA') && path.join(fromEnv('LOCALAPPDATA') as string, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]),
      'msedge',
      'chrome',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      ...existing([
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]),
      'google-chrome',
      'chromium',
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
