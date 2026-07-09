// Content script reserved for future page integration.
// ZapArc does not scan pages for legacy payment markers or inject prompts.

console.log('ZapArc content script loaded', {
  timestamp: new Date().toISOString(),
  location: window.location.href,
  documentReadyState: document.readyState
});
