import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const popupSource = readFileSync(new URL('./popup.ts', import.meta.url), 'utf8');

describe('transaction-detail support export controls', () => {
    it('wires the sanitized action to the allowlisted export mode', () => {
        expect(popupSource).toContain('id="tx-copy-sanitized-export"');
        expect(popupSource).toContain('buildSupportExport(payment, 0, false)');
    });

    it('requires confirmation before the detailed export mode', () => {
        expect(popupSource).toContain('id="tx-copy-detailed-export"');
        expect(popupSource).toMatch(/showConfirmDialog\([\s\S]*?buildSupportExport\(livePayment \|\| payment,[\s\S]*?, true\)/);
    });
});
