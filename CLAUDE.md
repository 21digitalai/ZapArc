# CLAUDE.md - ZapArc

ZapArc is a Chrome/Chromium MV3 extension for a self-custodial Bitcoin wallet
with Lightning and on-chain support.

## Development

- Run `npm run type-check` before handoff.
- Run `npm test` for the Vitest suite.
- Run `npm run build` for production extension verification.
- Load unpacked from `dist/` for browser QA.

## Architecture

- Breez SDK code lives in the popup context because MV3 service workers cannot
  run the required WASM runtime.
- Background code handles storage, alarms, and message routing.
- Content script code is currently reserved for future page integrations.
