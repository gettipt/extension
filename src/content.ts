/// <reference types="chrome" />

const BRIDGE_EVENT = 'TIPT_PAGE_402';

function handleBridgeEvent(event: MessageEvent) {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.type !== BRIDGE_EVENT) return;

  chrome.runtime.sendMessage({ type: 'PAGE_402_DETECTED' });
}

function injectPageHook() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-hook.js');

  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

window.addEventListener('message', handleBridgeEvent);
injectPageHook();
