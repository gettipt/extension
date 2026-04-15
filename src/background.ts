/// <reference types="chrome" />

// Background service worker for icon switching based on active tab URL

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  updateIcon(tab);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    updateIcon(tab);
  }
});

function updateIcon(tab: chrome.tabs.Tab) {
  if (!tab.url) return;

  const isBing = new URL(tab.url).hostname.includes('bing.com');
  const iconPath = isBing ? 'greenasterisk.png' : 'greyasterisk.png';

  chrome.action.setIcon({
    path: iconPath,
  });
}

// Set initial icon when service worker loads
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    updateIcon(tabs[0]);
  }
});
