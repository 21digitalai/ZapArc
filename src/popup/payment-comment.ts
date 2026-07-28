export function paymentCommentKey(walletId: string, subWalletIndex: number, paymentId: string): string {
    return `payment_comment_${walletId}_${subWalletIndex}_${paymentId}`;
}

function cleanComment(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

export function nonblankPaymentComment(value: unknown): string | undefined {
    return cleanComment(value);
}

export async function savePaymentComment(walletId: string | null, subWalletIndex: number, paymentId: unknown, comment: unknown): Promise<void> {
    const value = cleanComment(comment);
    if (!walletId || typeof paymentId !== 'string' || !value) return;
    await chrome.storage.local.set({ [paymentCommentKey(walletId, subWalletIndex, paymentId)]: value });
}

export async function loadPaymentComment(walletId: string | null, subWalletIndex: number, paymentId: unknown): Promise<string | undefined> {
    if (!walletId || typeof paymentId !== 'string') return undefined;
    const key = paymentCommentKey(walletId, subWalletIndex, paymentId);
    return cleanComment((await chrome.storage.local.get([key]))[key]);
}

export function extractLnurlPaymentComment(payment: any): string | undefined {
    const details = payment && payment.details;
    const inner = details && (details.inner || details);
    const comment = cleanComment(inner && inner.lnurlPayInfo && inner.lnurlPayInfo.comment);
    return comment ? comment.trim() : undefined;
}

export function shouldShowPaymentComment(description: unknown, comment: unknown): boolean {
    const value = cleanComment(comment);
    const descriptionValue = cleanComment(description);
    return !!value && value.trim() !== (descriptionValue || '').trim();
}

export function renderPaymentCommentDetailRow(comment: unknown, escapeHtml: (value: string) => string): string {
    const value = cleanComment(comment);
    if (!value) return '';
    return `<div class="tx-detail-row"><span class="tx-detail-label">Comment</span><span class="tx-detail-value">${escapeHtml(value)}</span></div>`;
}
