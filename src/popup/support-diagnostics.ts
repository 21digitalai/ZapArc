import type { Payment } from '@breeztech/breez-sdk-spark/web';

export interface SdkSupportLog {
    at: string;
    level: string;
    line: string;
}

const MAX_LOGS = 250;
const STORAGE_KEY = 'zaparc_breez_support_logs_v1';
const TRUE_SECRET_KEYS = /seed|mnemonic|private.?key|preimage|proof|api.?key|access.?token|refresh.?token|authorization/i;
const TRUE_SECRET_PATTERNS: RegExp[] = [
    /\b(?:seed|mnemonic|private[_ -]?key|preimage|proof)\b\s*[:=]\s*[^\s,;"']+/gi,
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;"']+/gi,
];
const SUPPORT_IDENTIFIER_KEYS = /(?:^|_)(?:id|invoice|payment_hash|destination_pubkey|address|lnurl)(?:$|_)/i;

function removeTrueSecrets(value: string): string {
    return TRUE_SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, match => {
        const separator = match.includes('=') ? '=' : ':';
        return `${match.split(separator)[0]}${separator}[REDACTED]`;
    }), value);
}

function loadRing(): SdkSupportLog[] {
    try {
        const value = globalThis.localStorage?.getItem(STORAGE_KEY);
        const parsed = value ? JSON.parse(value) : [];
        return Array.isArray(parsed) ? parsed.slice(-MAX_LOGS) : [];
    } catch {
        return [];
    }
}

const ring: SdkSupportLog[] = loadRing();

function persistRing(): void {
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(ring));
    } catch {
        // Diagnostics must never interrupt wallet operation.
    }
}

export function recordSdkLog(level: unknown, line: unknown, at: Date = new Date()): void {
    ring.push({ at: at.toISOString(), level: String(level || 'INFO'), line: removeTrueSecrets(String(line || '')) });
    if (ring.length > MAX_LOGS) ring.splice(0, ring.length - MAX_LOGS);
    persistRing();
}

export function recentSdkLogs(): SdkSupportLog[] {
    return ring.map(entry => ({ ...entry }));
}

export function sanitizeSupportValue(value: unknown, redactIdentifiers = false, key = ''): unknown {
    if (TRUE_SECRET_KEYS.test(key)) return '[REDACTED]';
    if (redactIdentifiers && SUPPORT_IDENTIFIER_KEYS.test(key.replace(/([a-z])([A-Z])/g, '$1_$2'))) return '[REDACTED]';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string') {
        const protectedValue = removeTrueSecrets(value);
        if (!redactIdentifiers) return protectedValue;
        return protectedValue
            .replace(/\b(?:lnbc|lntb|lnbcrt)[0-9a-z]+\b/gi, '[REDACTED:invoice]')
            .replace(/\b(?:lnurl)[0-9a-z]+\b/gi, '[REDACTED:lnurl]')
            .replace(/\b[0-9a-f]{64,66}\b/gi, '[REDACTED:identifier]')
            .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[REDACTED:id]');
    }
    if (Array.isArray(value)) return value.map(item => sanitizeSupportValue(item, redactIdentifiers));
    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).reduce((result, [entryKey, entryValue]) => {
            result[entryKey] = sanitizeSupportValue(entryValue, redactIdentifiers, entryKey);
            return result;
        }, {} as Record<string, unknown>);
    }
    return value;
}

export function htlcClassification(status: unknown): string {
    const value = String(status || '').toLowerCase();
    if (!value) return 'Unavailable';
    if (value === 'returned') return 'Returned (balance restoration not verified)';
    if (value === 'waitingforpreimage') return 'Waiting for preimage';
    if (value === 'preimageshared') return 'Preimage shared; settlement not yet confirmed';
    return String(status);
}

function getHtlcDetails(payment?: Payment): Record<string, unknown> | undefined {
    const details = payment?.details;
    if (!details || !('htlcDetails' in details) || !details.htlcDetails) return undefined;
    return details.htlcDetails as unknown as Record<string, unknown>;
}

export function buildSupportExport(payment: Payment | undefined, balanceSats: number, detailed: boolean): string {
    const htlc = getHtlcDetails(payment);
    const snapshot = {
        format: 'zaparc-breez-support-v2',
        generatedAt: new Date().toISOString(),
        privacy: detailed ? 'detailed user-approved export' : 'sanitized support export',
        breez: {
            payment: payment || null,
        },
        zaparc: {
            currentBalanceSats: balanceSats,
            htlcClassification: htlcClassification(htlc?.status),
            historicalLogs: ring.length ? 'recent persisted SDK log window available' : 'unavailable for this older payment',
        },
        sdkLogs: ring,
    };
    return JSON.stringify(sanitizeSupportValue(snapshot, !detailed), null, 2);
}
