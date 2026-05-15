/// <reference types="chrome" />

// Background service worker for icon switching based on 402 responses.

const GREY_ICON = 'greyasterisk.png';
const GREEN_ICON = 'greenasterisk.png';
const tabsWith402 = new Set<number>();

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  updateIcon(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    tabsWith402.delete(tabId);
    updateIcon(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabsWith402.delete(tabId);
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.statusCode !== 402) {
      return undefined;
    }

    if (details.tabId >= 0) {
      tabsWith402.add(details.tabId);
      updateIcon(details.tabId);
      return undefined;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabId = tabs[0]?.id;
      if (activeTabId === undefined) {
        return;
      }

      tabsWith402.add(activeTabId);
      updateIcon(activeTabId);
    });

    return undefined;
  },
  { urls: ['<all_urls>'] },
);

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'PAGE_402_DETECTED') {
    return;
  }

  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return;
  }

  tabsWith402.add(tabId);
  updateIcon(tabId);
});

function updateIcon(tabId?: number) {
  if (tabId === undefined) return;

  const iconPath = tabsWith402.has(tabId) ? GREEN_ICON : GREY_ICON;

  chrome.action.setIcon({
    tabId,
    path: iconPath,
  });
}

// Set initial icon when service worker loads
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    updateIcon(tabs[0].id);
  }
});
