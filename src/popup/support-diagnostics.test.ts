import { describe, expect, it } from 'vitest';
import { buildSupportExport, htlcClassification, recentSdkLogs, recordSdkLog, sanitizeSupportValue } from './support-diagnostics';

describe('support diagnostics', () => {
    it('irreversibly removes true secrets from support exports', () => {
        const output = buildSupportExport({ paymentHash: 'hash', details: { preimage: 'secret' }, token: 'abc' }, 12, true);
        expect(output).not.toContain('"preimage": "secret"');
        expect(output).not.toContain('abc');
        expect(sanitizeSupportValue('Authorization: Bearer shh')).toBe('Authorization:[REDACTED]');
    });

    it('keeps a bounded log ring and uses cautious returned classification', () => {
        for (let index = 0; index < 255; index++) recordSdkLog('DEBUG', `line ${index}`);
        expect(recentSdkLogs()).toHaveLength(250);
        expect(htlcClassification('Returned')).toContain('not verified');
    });
});
