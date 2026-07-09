# Extension Icons

This directory should contain the following icon files:
- icon16.png (16x16 pixels)
- icon32.png (32x32 pixels) 
- icon48.png (48x48 pixels)
- icon128.png (128x128 pixels)

These icons will be used for:
- Browser toolbar (16px, 32px)
- Extension management page (48px)
- Chrome Web Store (128px)

The icons should represent ZapArc wallet functionality,
possibly incorporating lightning bolt and Bitcoin symbols.

## Source of truth (important)

Use HTML canvas files in this folder as the canonical source:
- `icon-square.html` / `icon-square-v6-preview.html` for extension/store icon style (with background)
- `bolt-transparent-current.html` for in-wallet icon style (transparent, no background)

Do **not** hand-edit PNG pixels.
Regenerate PNGs from the HTML source whenever icon changes are needed.
