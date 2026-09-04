# Browser extension QA

Use an unpacked build in Chrome for browser-visible ZapArc changes; a localhost or
`file://` preview is not equivalent to extension runtime QA.

For transaction diagnostics, verify the detail view at desktop and narrow popup
width: status refresh success/error, the sanitized export confirmation, detailed
export confirmation, clipboard success/fallback download, and the absence of
native browser dialogs or raw controls. Reload after persisted mutations to
confirm their visible state is retained.
