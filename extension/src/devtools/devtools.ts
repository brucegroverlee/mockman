/**
 * Registers the "Mockman" panel next to Network, Console and Application.
 *
 * Runs once per DevTools window. Nothing else belongs here — the panel's own
 * document does the real work.
 */

chrome.devtools.panels.create(
  'Mockman',
  '', // no icon for now
  'devtools/panel.html',
);
