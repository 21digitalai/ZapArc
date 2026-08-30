export interface SdkSupportLog {
    at: string;
    level: string;
    line: string;
}

const MAX_LOGS = 250;
const SECRET_PATTERNS: RegExp[] = [
    /\b(?:seed|mnemonic|private[_ -]?key|preimage|proof)\b\s*[:=]\s*[^\s,;"']+/gi,
    /\b(?:api[_ -]?key|token|authorization)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;"']+/gi,
];
const ring: SdkSupportLog[] = [];

export function recordSdkLog(level: unknown, line: unknown, at: Date = new Date()): void {
    ring.push({ at: at.toISOString(), level: String(level || 'INFO'), line: String(line || '') });
    if (ring.length > MAX_LOGS) ring.splice(0, ring.length - MAX_LOGS);
}

export function recentSdkLogs(): SdkSupportLog[] {
    return ring.map(entry => ({ ...entry }));
}

export function sanitizeSupportValue(value: unknown): unknown {
    if (typeof value === 'string') {
        return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, match => {
            const separator = match.includes('=') ? '=' : ':';
            return `${match.split(separator)[0]}${separator}[REDACTED]`;
        }), value);
    }
    if (Array.isArray(value)) return value.map(sanitizeSupportValue);
    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).reduce((result, entry) => {
            const key = entry[0];
            const normalized = key.toLowerCase();
            result[key] = /seed|mnemonic|private.?key|preimage|proof|api.?key|token|authorization/.test(normalized)
                ? '[REDACTED]'
                : sanitizeSupportValue(entry[1]);
            return result;
        }, {} as Record<string, unknown>);
    }
    return value;
}

export function htlcClassification(status: unknown): string {
    const value = String(status || '').toLowerCase();
    if (!value) return 'Unavailable';
    if (value.includes('returned')) return 'Returned (balance restoration not verified)';
    if (value.includes('pending')) return 'Pending';
    if (value.includes('failed')) return 'Failed';
    if (value.includes('complete') || value.includes('success')) return 'Completed';
    return String(status);
}

export function buildSupportExport(payment: unknown, balanceSats: number, detailed: boolean): string {
    const paymentRecord = payment && typeof payment === 'object' ? payment as Record<string, unknown> : {};
    const details = paymentRecord.details && typeof paymentRecord.details === 'object' ? paymentRecord.details as Record<string, unknown> : {};
    const snapshot = {
        format: 'zaparc-breez-support-v1',
        generatedAt: new Date().toISOString(),
        privacy: detailed ? 'detailed logs may include payment identifiers; true secrets are removed' : 'sanitized',
        breezPayment: {
            id: paymentRecord.id,
            status: paymentRecord.status,
            paymentType: paymentRecord.paymentType,
            method: paymentRecord.method,
            amount: paymentRecord.amount,
            fees: paymentRecord.fees,
            timestamp: paymentRecord.timestamp,
            paymentHash: paymentRecord.paymentHash || details.paymentHash,
            htlcStatus: details.htlcStatus || paymentRecord.htlcStatus,
            htlcClassification: htlcClassification(details.htlcStatus || paymentRecord.htlcStatus),
            htlcExpiry: details.htlcExpiry || paymentRecord.htlcExpiry,
        },
        zaparc: { currentBalanceSats: balanceSats, historicalLogs: ring.length ? 'recent SDK log window available' : 'unavailable for this older payment' },
        sdkLogs: ring,
    };
    return JSON.stringify(sanitizeSupportValue(snapshot), null, 2);
}
