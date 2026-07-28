export type ClaimStatus = 'confirming' | 'claiming' | 'retrying' | 'too-small' | 'claimed';

export type ClaimRow = {
    key: string;
    txid: string;
    vout: number;
    amountSats: number;
    status: ClaimStatus;
    message?: string;
    confirmations?: number;
    requiredConfirmations?: number;
};

const provisionalClaims = new Map<string, ClaimRow>();

export function upsertProvisionalClaim(row: ClaimRow): void {
    provisionalClaims.set(row.key, row);
}

export function removeProvisionalClaim(key: string): void {
    provisionalClaims.delete(key);
}

export function getProvisionalClaims(): ClaimRow[] {
    return Array.from(provisionalClaims.values());
}

function sdkErrorMessage(value: unknown, depth = 0, seen = new Set<object>()): string | undefined {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return undefined;
    seen.add(value);
    const error = value as Record<string, unknown>;
    for (const candidate of [error.message, error.reason, error.error, error.inner, error.cause]) {
        const message = sdkErrorMessage(candidate, depth + 1, seen);
        if (message) return message;
    }
    const tag = error.tag || error.variant || error.code;
    return typeof tag === 'string' && tag ? tag : undefined;
}

export function getClaimKey(txid: string, vout: number): string {
    return `${txid}:${vout}`;
}

export function classifyClaimError(error: unknown, amountSats: number): Pick<ClaimRow, 'status' | 'message'> {
    const message = sdkErrorMessage(error) || 'Claim temporarily unavailable';
    const raw = JSON.stringify(error, (_key, value) => typeof value === 'bigint' ? value.toString() : value).toLowerCase();
    const text = `${message} ${raw}`.toLowerCase();
    const required = error && typeof error === 'object'
        ? Number(((error as any).inner && (error as any).inner.requiredFeeSats) || (error as any).requiredFeeSats)
        : NaN;
    const tooSmall = /dust|amount.*too small|below.*minimum|less than.*(?:fee|minimum)/.test(text) ||
        (Number.isFinite(required) && amountSats <= required + 546);
    if (tooSmall) return { status: 'too-small', message: 'Too small to claim at current network fees.' };
    if (/confirm|mature|utxo|fee|network|timeout|temporar|unavailable|connection/.test(text)) {
        return { status: 'retrying', message: 'Claim pending. ZapArc will retry automatically.' };
    }
    return { status: 'retrying', message: message === 'Claim temporarily unavailable' ? 'Claim pending. ZapArc will retry automatically.' : message };
}

export function mergeClaimRows(rows: ClaimRow[], completedKeys: Set<string>): ClaimRow[] {
    const seen = new Set<string>();
    return rows.filter((row) => {
        if (completedKeys.has(row.key) || seen.has(row.key)) return false;
        seen.add(row.key);
        return true;
    });
}
