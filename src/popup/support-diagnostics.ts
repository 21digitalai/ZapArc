import type { Payment } from '@breeztech/breez-sdk-spark/web';

export interface SdkSupportLog {
    at: string;
    level: string;
    line: string;
    sessionId?: string;
}

const MAX_LOGS = 2_000;
const MAX_PERSISTED_BYTES = 3 * 1024 * 1024;
const STORAGE_KEY = 'zaparc_breez_support_logs_v1';
const TRUE_SECRET_KEYS = /seed|mnemonic|private.?key|preimage|proof|api.?key|access.?token|refresh.?token|authorization/i;
const TRUE_SECRET_PATTERNS: RegExp[] = [
    /\b(?:seed|mnemonic|private[_ -]?key|preimage|proof)\b\s*[:=]\s*[^\s,;"']+/gi,
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;"']+/gi,
];
const SUPPORT_IDENTIFIER_KEYS = /(?:^|_)(?:id|invoice|payment_hash|destination_pubkey|address|lnurl)(?:$|_)/i;

export interface PaymentLogCorrelation {
    id?: string;
    timestamp?: number | bigint;
    paymentHash?: string;
    bolt11?: string;
    invoice?: string;
    status?: string;
    paymentType?: string;
    type?: string;
    amount?: number | bigint;
    fees?: number | bigint;
    details?: unknown;
}

export interface SdkSupportSnapshots {
    payment?: Payment;
    walletInfo?: unknown;
    syncSucceeded: boolean;
    syncError?: string;
}

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
let activeSessionId: string | undefined;

function trimRing(): void {
    if (ring.length > MAX_LOGS) ring.splice(0, ring.length - MAX_LOGS);
    while (ring.length > 1 && JSON.stringify(ring).length > MAX_PERSISTED_BYTES) ring.shift();
}

function persistRing(): void {
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(ring));
    } catch {
        // Diagnostics must never interrupt wallet operation.
    }
}

export function recordSdkLog(level: unknown, line: unknown, at: Date = new Date()): void {
    ring.push({
        at: at.toISOString(),
        level: String(level || 'INFO'),
        line: removeTrueSecrets(String(line || '')),
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    });
    trimRing();
    persistRing();
}

export function beginSdkLogSession(at: Date = new Date()): string {
    activeSessionId = `${at.toISOString()}-${Math.random().toString(36).slice(2, 10)}`;
    recordSdkLog('INFO', 'ZapArc SDK wallet session started', at);
    return activeSessionId;
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
            .replace(/\b(?:payment[_ -]?id|payment[_ -]?hash|invoice|destination[_ -]?pubkey|address|lnurl|id)\s*[:=]\s*[^\s,;"']+/gi, match => {
                const separator = match.includes('=') ? '=' : ':';
                return `${match.split(separator)[0]}${separator}[REDACTED]`;
            })
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
    return JSON.stringify(
        sanitizeSupportValue(snapshot, !detailed),
        (_key, value) => typeof value === 'bigint' ? value.toString() : value,
        2,
    );
}

function paymentTimestampMs(payment?: PaymentLogCorrelation): number | undefined {
    if (!payment) return undefined;
    const value = Number(payment.timestamp);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 10_000_000_000 ? value * 1000 : value;
}

function collectPaymentCorrelationValues(payment?: PaymentLogCorrelation): string[] {
    if (!payment) return [];
    const values = new Set<string>();
    const visit = (value: unknown, key = ''): void => {
        if (typeof value === 'string') {
            const normalizedKey = key.replace(/([a-z])([A-Z])/g, '$1_$2');
            if (SUPPORT_IDENTIFIER_KEYS.test(normalizedKey) && value.length >= 8) values.add(value);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(item => visit(item, key));
            return;
        }
        if (value && typeof value === 'object') {
            Object.entries(value as Record<string, unknown>).forEach(([entryKey, entryValue]) => visit(entryValue, entryKey));
        }
    };
    visit(payment);
    return [...values];
}

/**
 * Export the full retained Breez SDK context for support. Ordinary payment
 * identifiers, invoices, addresses, pubkeys and paths are preserved. Only
 * credential patterns removed at ingestion time remain unavailable.
 */
export function buildSdkLogsExport(
    payment: PaymentLogCorrelation | undefined,
    snapshots?: SdkSupportSnapshots,
    now = new Date(),
): string {
    const generatedAt = now.toISOString();
    const nowMs = now.getTime();
    const windowMs = 15 * 60 * 1000;
    const paymentAt = paymentTimestampMs(payment);
    const paymentTimeWindow = paymentAt === undefined
        ? []
        : ring.filter(entry => Math.abs(Date.parse(entry.at) - paymentAt) <= windowMs);
    const correlationValues = collectPaymentCorrelationValues(payment);
    const exactPaymentLogs = paymentTimeWindow.filter(entry => correlationValues.some(value => entry.line.includes(value)));
    const recentWindow = ring.filter(entry => Date.parse(entry.at) >= nowMs - windowMs);
    const currentSessionLogs = activeSessionId
        ? ring.filter(entry => entry.sessionId === activeSessionId)
        : [];
    const prepareLogs = (logs: SdkSupportLog[]): unknown[] => logs.map(entry => sanitizeSupportValue(entry, false));
    const manifest = globalThis.chrome?.runtime?.getManifest?.();

    const nativePayment = snapshots?.payment;
    const htlc = getHtlcDetails(nativePayment);

    return JSON.stringify(sanitizeSupportValue({
        schemaVersion: 1,
        exportType: 'sdk-support-logs',
        generatedAt,
        app: {
            name: 'ZapArc Web',
            version: manifest?.version || 'unknown',
            sdkVersion: '@breeztech/breez-sdk-spark@0.23.1',
            platform: 'chrome-extension',
        },
        correlation: {
            paymentId: payment?.id || null,
            paymentTimestamp: paymentAt === undefined ? null : new Date(paymentAt).toISOString(),
            windowMinutes: 15,
            mode: 'identifier-match-plus-time-window-context',
            exactPaymentLogMatchAvailable: exactPaymentLogs.length > 0,
            note: exactPaymentLogs.length > 0
                ? 'Exact logs contain a payment identifier from the selected Breez payment. Time-window logs are broader wallet context.'
                : 'No SDK log line containing an identifier from the selected payment was retained. Time-window logs are broader wallet context only.',
        },
        retention: {
            maxEntries: MAX_LOGS,
            maxPersistedBytes: MAX_PERSISTED_BYTES,
            retainedEntries: ring.length,
            persisted: true,
            sanitized: false,
            note: 'The full bounded SDK history is included so wallet import/recovery and historical resync evidence is not discarded merely because it does not match the selected payment.',
        },
        warning: 'Contains detailed wallet and payment metadata. Share only with a trusted support recipient.',
        breez: {
            paymentSnapshot: nativePayment || null,
            walletInfo: snapshots?.walletInfo || null,
        },
        zaparc: {
            authoritativeSync: {
                attempted: snapshots !== undefined,
                succeeded: snapshots?.syncSucceeded ?? false,
                error: snapshots?.syncError || null,
            },
            htlcStatusLabel: htlcClassification(htlc?.status),
            note: nativePayment
                ? 'Breez-native payment and wallet snapshots were captured after a fresh sync. ZapArc interpretation is kept separate.'
                : 'No live Breez payment snapshot was available; retained SDK logs and cached correlation are included.',
        },
        exactPaymentLogs: prepareLogs(exactPaymentLogs),
        paymentTimeWindowAvailable: paymentTimeWindow.length > 0,
        paymentTimeWindowLogs: prepareLogs(paymentTimeWindow),
        recentWindowLogs: prepareLogs(recentWindow),
        currentSdkSessionLogs: prepareLogs(currentSessionLogs),
        fullRetainedSdkLogs: prepareLogs(ring),
    }, false), (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
}
