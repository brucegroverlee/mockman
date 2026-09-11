/**
 * The relay. Runs in the extension's ISOLATED world at document_start, in every
 * frame.
 *
 * It exists purely because the interceptor needs `chrome.storage` data but lives
 * in the page's MAIN world, where no `chrome.*` API is reachable. This script can
 * see both `chrome.runtime` and the page's DOM, so it ferries config down and
 * hit reports back up.
 *
 * The tab id is deliberately *not* sent from here. The service worker reads it
 * from `sender.tab.id`, so a hostile page cannot claim to be a different tab.
 */

import { PAGE_EVENT } from '@mockman/shared';
import type {
  BodyEventDetail,
  ConfigEventDetail,
  FromWorker,
  HitEventDetail,
  TabConfig,
  ToWorker,
  WorkerBroadcast,
} from '@mockman/shared';

/** Inert until told otherwise, so an unreachable worker means "do not mock". */
let lastConfig: TabConfig = { active: false, observed: false, mocks: [] };

function pushConfigToPage(config: TabConfig): void {
  lastConfig = config;
  const detail: ConfigEventDetail = { config };
  document.dispatchEvent(new CustomEvent(PAGE_EVENT.config, { detail }));
}

/**
 * `chrome.runtime` throws once the extension is reloaded or updated, which
 * happens constantly during development. Swallow it: the page keeps working with
 * whatever config it already has.
 */
async function ask(message: ToWorker): Promise<FromWorker | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as FromWorker;
  } catch {
    return null;
  }
}

async function fetchAndPushConfig(): Promise<void> {
  const reply = await ask({ type: 'get-config' });
  if (reply?.type === 'config') pushConfigToPage(reply.config);
  else pushConfigToPage({ active: false, observed: false, mocks: [] });
}

// The interceptor may load before or after us — there is no ordering guarantee
// between the MAIN and ISOLATED worlds — so it announces itself and we also push
// unprompted below. Whichever happens first, the page ends up configured.
document.addEventListener(PAGE_EVENT.ready, () => {
  pushConfigToPage(lastConfig);
  void fetchAndPushConfig();
});

document.addEventListener(PAGE_EVENT.hit, (event) => {
  const detail = (event as CustomEvent<HitEventDetail>).detail;
  if (detail?.hit) void ask({ type: 'report-hit', hit: detail.hit });
});

// A captured response body, arriving after the hit that named it. It goes to the
// worker rather than to the panel because the panel is usually closed when the
// request happens, and is the whole point of keeping the body at all.
document.addEventListener(PAGE_EVENT.body, (event) => {
  const detail = (event as CustomEvent<BodyEventDetail>).detail;
  if (detail?.key && detail.captured) {
    void ask({ type: 'report-hit-body', key: detail.key, captured: detail.captured });
  }
});

// Live updates: an edit in the panel (or over MCP) reaches the page without a
// reload.
chrome.runtime.onMessage.addListener((message: WorkerBroadcast) => {
  if (message?.type === 'workspace-changed') void fetchAndPushConfig();
});

void fetchAndPushConfig();
