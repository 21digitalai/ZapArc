// Content script reserved for future page integration.
// ZapArc does not scan pages for legacy LNTIP markers or inject payment prompts.

console.log('ZapArc content script loaded', {
  timestamp: new Date().toISOString(),
  location: window.location.href,
  documentReadyState: document.readyState
});
