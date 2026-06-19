# ZapArc Extension — Style Guide

> Single source of truth for UI classes in this browser extension.
> Builder: read this before UI work. Update it when adding new classes or components.
>
> Rules: follow `nexus/docs/engineering/UI_PRINCIPLES.md` — semantic class anchors first, composable modifiers, and pure CSS classes for styling.

---

## Stack

- **Framework:** Vanilla TypeScript browser extension popup
- **Styling:** Pure CSS in `src/popup/popup.css`
- **Theme:** Dark theme with CSS custom properties

---

## Tokens

| Token | Value |
|---|---|
| Primary | `--brand: #F7931A` |
| Primary hover | `--brand-hover: #e8850f` |
| Danger | `--error: #f44336` |
| Warning | `--warning: #FF9800` |
| Success | `--success: #4CAF50` |
| Info | Use `--text-secondary` unless a component defines a specific info color |
| Surface | `--surface: #1a1a2e`; `--card-bg: rgba(255, 255, 255, 0.08)` |
| Surface hover | Component-specific translucent white overlays |
| Border | `--border-subtle`, `--border-light`, `--border-medium` |
| Text | `--text-primary: #FFFFFF` |
| Text muted | `--text-secondary: rgba(255, 255, 255, 0.6)` |
| Font | System UI stack in `body` |
| Font mono | Browser monospace for invoice text |
| Border radius (small) | `--radius-input: 8px` |
| Border radius (default) | `--radius-button: 12px` |
| Border radius (large) | `--radius-card: 16px` |

---

## Surfaces

`body.full-window-mode #app` — framed full extension/fullscreen shell. Use only for `?view=full` so popup mode keeps the fixed browser-extension dimensions.

`.payment-preview` — framed payment confirmation panel for send flows.

`.withdraw-form-container` — send form surface.

`.modal` — overlay dialog.

---

## Typography

`.payment-preview-title` — compact title inside payment preview panels.

`.text-muted` — use `--text-secondary` when adding muted helper text.

---

## Buttons

`.btn-primary` — primary action button.

`.btn-secondary` — secondary action button.

`.contact-action-btn` — compact contact action icon button.

---

## Badges

`.contact-self-badge` — label for the active wallet/contact identity.

---

## Form Controls

`.currency-select` — send amount currency selector.

`.invoice-text` — multiline invoice text area.

`.conversion-hint` — live amount conversion hint below send inputs.

---

## Layout

`.payment-preview-row` — two-column label/value row inside payment preview panels.

`.invoice-row` — invoice text plus copy action row.

`.quick-amounts` — quick amount button group.

---

## Components

`.payment-preview-value` — right-aligned value in a payment preview row.
  `.amount` — stacked sats and fiat amount display.

`.preview-sats` — primary satoshi amount within `.payment-preview-value.amount`.

`.preview-fiat` — secondary fiat equivalent or unavailable state within `.payment-preview-value.amount`.
