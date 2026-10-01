/**
 * Exploration: help the agent *author* a targeted test script.
 *
 * Generic probes can only tell you the app still starts. Testing what a change
 * actually does requires a scenario written against that change's real surfaces —
 * and writing one blind produces selectors that do not exist and assertions that
 * never had a chance to pass.
 *
 * This module maps what is actually there:
 *   - every interactive element with a durable selector and its visible text
 *   - headings and landmarks, so a reviewer can see the page structure
 *   - dialogs/modals present at this moment
 *   - the main process's registered IPC channels and application menu
 *
 * The output is meant to be read, then turned into a scenario. It asserts nothing.
 */
import { join } from 'node:path';
import { writeJson, writeText } from './util.mjs';

/**
 * Collect an interaction map from a page.
 *
 * Selector preference is deliberate: `data-testid`, then `id`, then a stable
 * attribute, then a short structural path. The first three survive styling and
 * copy changes; the structural fallback is a last resort and is marked as fragile
 * so the agent knows to prefer something better when it exists.
 */
export const EXPLORE_EXPRESSION = `(() => {
  const cssEscape = (value) => (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/([^\\w-])/g, '\\\\$1');

  const selectorFor = (el) => {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy');
    if (testId) return { selector: '[data-testid="' + testId + '"]', stable: true };

    if (el.id) return { selector: '#' + cssEscape(el.id), stable: true };

    for (const attr of ['name', 'aria-label', 'placeholder', 'title', 'alt', 'href']) {
      const value = el.getAttribute(attr);
      if (value && value.length < 60) {
        return { selector: el.tagName.toLowerCase() + '[' + attr + '="' + value.replace(/"/g, '\\\\"') + '"]', stable: true };
      }
    }

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return { selector: parts.join(' > '), stable: false };
  };

  const textOf = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 90);

  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const interactiveSelector = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=switch], [onclick], [tabindex]:not([tabindex="-1"])';
  const interactive = [...document.querySelectorAll(interactiveSelector)].slice(0, 250).map((el) => {
    const found = selectorFor(el);
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      role: el.getAttribute('role') || null,
      selector: found.selector,
      stableSelector: found.stable,
      text: textOf(el),
      visible: isVisible(el),
      disabled: el.disabled === true,
      checked: typeof el.checked === 'boolean' ? el.checked : null,
    };
  }).filter((item) => item.visible || item.text !== '');

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5')].slice(0, 80).map((h) => ({
    level: h.tagName.toLowerCase(),
    text: textOf(h),
    selector: selectorFor(h).selector,
  }));

  const landmarks = [...document.querySelectorAll('header,nav,main,aside,footer,section[aria-label],[role=navigation],[role=main],[role=dialog],[role=tablist]')]
    .slice(0, 60).map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      label: el.getAttribute('aria-label') || null,
      selector: selectorFor(el).selector,
    }));

  const dialogs = [...document.querySelectorAll('[role=dialog], .ant-modal, .ant-drawer, dialog[open]')]
    .filter(isVisible).slice(0, 10).map((el) => ({
      selector: selectorFor(el).selector,
      title: textOf(el).slice(0, 120),
    }));

  const forms = [...document.querySelectorAll('form')].slice(0, 20).map((form) => ({
    selector: selectorFor(form).selector,
    fields: [...form.querySelectorAll('input,select,textarea')].slice(0, 30).map((f) => ({
      selector: selectorFor(f).selector,
      name: f.getAttribute('name'),
      type: f.getAttribute('type') || f.tagName.toLowerCase(),
      placeholder: f.getAttribute('placeholder'),
      label: textOf(f),
    })),
  }));

  const routes = [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))
    .filter((href) => href && (href.startsWith('#/') || href.startsWith('/') || href.startsWith('#!'))))].slice(0, 60);

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyTextLength: (document.body?.innerText ?? '').trim().length,
    interactive,
    headings,
    landmarks,
    dialogs,
    forms,
    routes,
    framework: {
      react: Boolean(document.querySelector('#root,#app,[data-reactroot]')) || Boolean(window.React),
      antd: Boolean(document.querySelector('.ant-btn,.ant-modal,.ant-layout')),
      vue: Boolean(window.Vue) || Boolean(document.querySelector('[data-v-app]')),
    },
  };
})()`;

/** Ask the main process for the API surface a test script might need. */
export const EXPLORE_MAIN_EXPRESSION = ({ ipcMain, BrowserWindow, Menu, app }) => {
  const channels = { on: [], handle: [], handleOnce: [] };
  try {
    channels.on = ipcMain.eventNames().map(String).sort();
  } catch {}
  try {
    // `_invokeHandlers` is private, but this is a read-only exploration aid and the
    // alternative is not being able to see the IPC surface at all.
    channels.handle = [...(ipcMain._invokeHandlers?.keys?.() ?? [])].map(String).sort();
  } catch {}
  try {
    channels.handleOnce = [...(ipcMain._invokeHandlersOnce?.keys?.() ?? [])].map(String).sort();
  } catch {}

  let menu = null;
  try {
    const applicationMenu = Menu.getApplicationMenu();
    menu = applicationMenu
      ? applicationMenu.items.map((item) => ({
        label: item.label,
        role: item.role ?? null,
        enabled: item.enabled,
        submenu: item.submenu ? item.submenu.items.map((sub) => ({ label: sub.label, role: sub.role ?? null, enabled: sub.enabled })) : [],
      }))
      : null;
  } catch {}

  return {
    appName: app.getName(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    locale: app.getLocale(),
    channels,
    menu,
    windowCount: BrowserWindow.getAllWindows().length,
    windows: BrowserWindow.getAllWindows().map((w) => {
      let title = null;
      let url = null;
      try {
        title = w.getTitle();
        url = w.webContents.getURL();
      } catch {}
      return { title, url };
    }),
  };
};

/** Build the interaction map for every application window plus the main process. */
export async function exploreRevision({ launch, artifactsDir }) {
  const windows = [];
  for (const page of launch.pages ?? []) {
    const target = page.target ?? {};
    if (String(target.url ?? '').startsWith('devtools://')) continue;
    try {
      const map = await page.evaluate(EXPLORE_EXPRESSION);
      windows.push({ index: windows.length, ...map });
    } catch (error) {
      windows.push({ index: windows.length, url: target.url, error: error.message });
    }
  }

  let mainProcess = null;
  try {
    mainProcess = await launch.mainEvaluate(EXPLORE_MAIN_EXPRESSION);
  } catch (error) {
    mainProcess = { error: error.message };
  }

  const map = {
    generatedAt: new Date().toISOString(),
    driver: launch.driver,
    engine: launch.version ?? null,
    windows,
    mainProcess,
  };

  await writeJson(join(artifactsDir, 'explore.json'), map);
  return map;
}

/** Human- and agent-readable rendering of an interaction map. */
export function renderExplore(map) {
  const lines = [];
  const push = (...values) => lines.push(...values);

  push('# Interaction map', '');
  push(`Driver: ${map.driver ?? 'unknown'}`);
  push('');

  for (const window of map.windows ?? []) {
    push(`## Window ${window.index}: ${window.title ?? '(untitled)'}`);
    push('');
    if (window.error) {
      push(`> Could not inspect: ${window.error}`);
      push('');
      continue;
    }
    push(`URL: \`${window.url}\``);
    push(`Text length: ${window.bodyTextLength}; framework hints: ${Object.entries(window.framework ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none detected'}`);
    push('');

    if ((window.headings ?? []).length > 0) {
      push('### Headings (page structure)');
      push('');
      for (const heading of window.headings) push(`- \`${heading.level}\` ${heading.text || '(empty)'}`);
      push('');
    }

    const stable = (window.interactive ?? []).filter((item) => item.stableSelector);
    const fragile = (window.interactive ?? []).filter((item) => !item.stableSelector);
    push(`### Interactive elements (${window.interactive?.length ?? 0})`);
    push('');
    if (stable.length > 0) {
      push('Durable selectors — prefer these:', '');
      push('| Selector | Kind | Text |');
      push('| --- | --- | --- |');
      for (const item of stable.slice(0, 80)) {
        push(`| \`${item.selector}\` | ${item.tag}${item.type ? `[${item.type}]` : ''}${item.disabled ? ' (disabled)' : ''} | ${String(item.text).replace(/\|/g, '\\|').slice(0, 60)} |`);
      }
      push('');
    }
    if (fragile.length > 0) {
      push(`Fragile selectors (${fragile.length}) — structural paths, will break on layout change. Use only if nothing better exists:`);
      push('');
      for (const item of fragile.slice(0, 30)) push(`- \`${item.selector}\` — ${item.tag} "${String(item.text).slice(0, 50)}"`);
      push('');
    }

    if ((window.forms ?? []).length > 0) {
      push('### Forms');
      push('');
      for (const form of window.forms) {
        push(`- \`${form.selector}\``);
        for (const field of form.fields) push(`  - \`${field.selector}\` (${field.type}${field.placeholder ? `, placeholder "${field.placeholder}"` : ''})`);
      }
      push('');
    }

    if ((window.dialogs ?? []).length > 0) {
      push('### Dialogs open right now');
      push('');
      for (const dialog of window.dialogs) push(`- \`${dialog.selector}\` — ${dialog.title}`);
      push('');
    }

    if ((window.routes ?? []).length > 0) {
      push('### Routes / links reachable from here');
      push('');
      for (const route of window.routes) push(`- \`${route}\``);
      push('');
    }
  }

  const main = map.mainProcess;
  push('## Main process');
  push('');
  if (!main || main.error) {
    push(`> Not available: ${main?.error ?? 'the main-process inspector was not reachable'}`);
    push('');
  } else {
    push(`App: ${main.appName} ${main.appVersion} (packaged: ${main.isPackaged}, locale: ${main.locale})`);
    push('');
    const channels = main.channels ?? {};
    for (const [kind, list] of Object.entries(channels)) {
      if (!list || list.length === 0) continue;
      push(`### IPC channels registered with \`ipcMain.${kind}\` (${list.length})`);
      push('');
      for (const channel of list) push(`- \`${channel}\``);
      push('');
    }
    if (main.menu) {
      push('### Application menu');
      push('');
      for (const item of main.menu) {
        push(`- ${item.label || `(${item.role ?? 'item'})`}${item.enabled === false ? ' (disabled)' : ''}`);
        for (const sub of item.submenu ?? []) push(`  - ${sub.label || `(${sub.role ?? 'item'})`}`);
      }
      push('');
    }
  }

  push('---', '');
  push('Next: turn what you need into a scenario and iterate with `ebb play`.');
  push('See `process/knowledge/scenario-authoring.md`.');
  push('');

  return `${lines.join('\n')}\n`;
}

export { writeText };
