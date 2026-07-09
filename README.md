# ZapArc — Self-Custodial Bitcoin Wallet

ZapArc is a self-custodial Bitcoin wallet extension with Lightning and on-chain support, powered by Breez SDK. It runs as a Chrome/Chromium MV3 extension and focuses on simple wallet management, fast Lightning payments, and optional tipping utilities.

## Highlights

- **Self-custodial**: BIP39 seed phrase, encrypted wallet storage, PIN unlock.
- **Lightning + on-chain**: Unified wallet experience with Lightning payments (Breez SDK).
- **Multi-wallet**: Create/import multiple wallets and switch between them.
- **Extension UI**: Popup wallet dashboard plus a dedicated settings page.
- **Tipping utilities (optional)**: Tip request detection and helper UI on supported pages.

## Quick Start

```bash
npm ci
npm run build
```

Load the extension:

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

Development watch build:

```bash
npm run dev
```

Type checking:

```bash
npm run type-check
```

## Project Structure

```
src/
├── background/        # Service worker (storage + alarms)
├── content/           # Page integration / tip detection
├── popup/             # Wallet UI (Breez SDK lives here)
├── settings/          # Settings UI
├── types/             # Shared TypeScript types
└── utils/             # Wallet, LNURL, storage, messaging, UI helpers
```

## Architecture Notes

- **Breez SDK runs only in the popup**. MV3 service workers cannot run WASM, so all SDK calls (connect, balance, pay, list payments) are in `src/popup/`.
- **Background is storage-only**: encrypted wallet metadata, settings, and alarms live in the service worker.

## Wallet & Network Support

- **Lightning**: Powered by Breez SDK Spark.
- **On-chain**: Wallet metadata and flows are set up for on-chain support alongside Lightning.

## Tipping Format (Optional Feature)

If enabled, the extension recognizes a standardized tip string:

```
[lntip:lnurl:lnurl1dp68gurn...:100:500:1000]
```

Also supports metadata:

```html
<meta name="lntip" content="lnurl:...:100:500:1000">
```

## Testing Notes

- Manual testing via `test.html` for tip detection.
- Extension flows are best validated by loading the unpacked build and exercising wallet create/import, send/receive, and rename/switch paths.

## Resources

- `BREEZ_SDK_SETUP.md` — Breez SDK notes
- `CURRENT_FUNCTIONALITY_GUIDE.md` — Current features and status
- `debug_instructions.md` — Debugging tips

## License

MIT. See [LICENSE](LICENSE).
