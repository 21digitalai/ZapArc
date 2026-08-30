// LNURL utilities for ZapArc wallet extension
// Handles LNURL parsing, validation, and operations using Breez SDK

import { WalletManager } from './wallet-manager';
import { LnurlPayResult } from './breez-sdk';

/**
 * Converts Lightning address to LNURL endpoint URL, or returns input unchanged if already LNURL.
 * Lightning address format: user@domain → https://domain/.well-known/lnurlp/user
 * @param input - Lightning address (user@domain) or LNURL string
 * @returns LNURL endpoint URL or original input
 */
export function convertToLnurl(input: string): string {
  const trimmed = input.trim();

  // Lightning address format: user@domain (but not if it starts with lnurl)
  if (trimmed.includes('@') && !trimmed.toLowerCase().startsWith('lnurl')) {
    const [username, domain] = trimmed.split('@');
    if (username && domain && domain.includes('.')) {
      return `https://${domain}/.well-known/lnurlp/${username}`;
    }
  }

  return trimmed;
}

/**
 * Validates if input is a valid Lightning address format.
 * @param input - String to validate
 * @returns true if valid Lightning address format (user@domain.tld)
 */
export function isLightningAddress(input: string): boolean {
  const trimmed = input.trim();

  // Must contain @ but not start with lnurl
  if (!trimmed.includes('@') || trimmed.toLowerCase().startsWith('lnurl')) {
    return false;
  }

  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return false;
  }

  const [username, domain] = parts;

  // Username must be non-empty and alphanumeric (with dots, dashes, underscores)
  if (!username || !/^[a-zA-Z0-9._-]+$/.test(username)) {
    return false;
  }

  // Domain must contain at least one dot and be valid
  if (!domain || !domain.includes('.') || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
    return false;
  }

  return true;
}

export interface LnurlPayData {
  callback: string;
  maxSendable: number;
  minSendable: number;
  metadata: string;
  tag: string;
  commentAllowed?: number;
}

export interface LnurlPayResponse {
  pr: string; // bolt11 invoice
  successAction?: {
    tag: string;
    message?: string;
    url?: string;
  };
}

export class LnurlManager {
  private walletManager: WalletManager;

  constructor(walletManager: WalletManager) {
    this.walletManager = walletManager;
  }

  /**
   * Parse and validate LNURL or Lightning address
   */
  async parseLnurl(lnurl: string): Promise<any> {
    try {
      // Validate LNURL or Lightning address format
      if (!this.isValidLnurlFormat(lnurl) && !isLightningAddress(lnurl)) {
        throw new Error('Invalid LNURL or Lightning address format');
      }

      // Convert Lightning address to LNURL endpoint if needed
      const resolvedLnurl = convertToLnurl(lnurl);

      // Use Breez SDK to parse LNURL
      const parsed = await this.walletManager.parseLnurl(resolvedLnurl);

      return parsed;
    } catch (error) {
      console.error('LNURL parsing failed:', error);
      throw new Error(`LNURL parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Pay LNURL with amount and optional comment
   * Returns confirmed payment result - waits for payment to complete
   */
  async payLnurl(lnurl: string, amount: number, comment?: string): Promise<LnurlPayResult> {
    try {
      // Parse LNURL first
      const reqData = await this.parseLnurl(lnurl);

      const payData = reqData.type === 'pay'
        ? reqData.data as LnurlPayData
        : reqData.type === 'lnurlPay'
          ? reqData as LnurlPayData
          : reqData.type === 'lightningAddress'
            ? reqData.payRequest as LnurlPayData
            : null;
      if (!payData) {
        throw new Error('LNURL is not a pay request');
      }

      // Validate amount is within bounds
      const amountMsat = amount * 1000;

      if (amountMsat < payData.minSendable || amountMsat > payData.maxSendable) {
        throw new Error(`Amount must be between ${payData.minSendable / 1000} and ${payData.maxSendable / 1000} sats`);
      }

      // LUD-12 only permits a nonblank comment when the recipient explicitly
      // advertises a positive limit. Do not forward unsupported comments.
      const hasComment = typeof comment === 'string' && comment.trim().length > 0;
      const allowed = Number(payData.commentAllowed || 0);
      if (hasComment && (!Number.isFinite(allowed) || allowed <= 0)) {
        throw new Error('This recipient does not accept comments. Remove the comment to continue.');
      }
      if (hasComment && comment!.length > allowed) {
        throw new Error(`Comment too long. Maximum ${payData.commentAllowed} characters allowed`);
      }

      // Check sufficient balance
      const hasSufficientBalance = await this.walletManager.hasSufficientBalance(amount);
      if (!hasSufficientBalance) {
        return {
          success: false,
          error: 'Insufficient balance for payment'
        };
      }

      // Execute payment and wait for confirmation
      const result = await this.walletManager.payLnurl(payData, amount, hasComment ? comment : undefined);

      return result;
    } catch (error) {
      console.error('LNURL payment failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'LNURL payment failed'
      };
    }
  }

  /**
   * Generate LNURL for receiving payments
   */
  async generateReceiveLnurl(): Promise<string> {
    try {
      const lnurl = await this.walletManager.generateReceiveLnurl();
      return lnurl;
    } catch (error) {
      console.error('LNURL generation failed:', error);
      throw new Error(`LNURL generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate LNURL format
   */
  private isValidLnurlFormat(lnurl: string): boolean {
    try {
      // LNURL should be a bech32 encoded string starting with 'lnurl'
      if (!lnurl.toLowerCase().startsWith('lnurl')) {
        return false;
      }

      // Basic length check (LNURL should be reasonably long)
      if (lnurl.length < 20) {
        return false;
      }

      // Additional validation could be added here
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Extract LNURL or Lightning address from various formats (QR codes, lightning: URIs, etc.)
   */
  extractLnurl(input: string): string | null {
    try {
      // Remove whitespace
      input = input.trim();

      // Handle lightning: URI
      if (input.toLowerCase().startsWith('lightning:')) {
        input = input.substring(10);
      }

      // Handle Lightning address (user@domain)
      if (isLightningAddress(input)) {
        return input;
      }

      // Handle direct LNURL
      if (input.toLowerCase().startsWith('lnurl')) {
        return input;
      }

      // Handle uppercase LNURL
      if (input.toUpperCase().startsWith('LNURL')) {
        return input.toLowerCase();
      }

      return null;
    } catch (error) {
      console.error('LNURL extraction failed:', error);
      return null;
    }
  }

  /**
   * Get payment limits for LNURL
   */
  async getLnurlPaymentLimits(lnurl: string): Promise<{ min: number; max: number } | null> {
    try {
      const parsed = await this.parseLnurl(lnurl);
      
      const payData = parsed.type === 'pay' ? parsed.data : parsed.type === 'lnurlPay' ? parsed : parsed.type === 'lightningAddress' ? parsed.payRequest : null;
      if (!payData) {
        return null;
      }
      return {
        min: Math.ceil(payData.minSendable / 1000), // Convert msat to sat
        max: Math.floor(payData.maxSendable / 1000)
      };
    } catch (error) {
      console.error('Failed to get LNURL payment limits:', error);
      return null;
    }
  }

  /**
   * Check if comment is allowed for LNURL
   */
  async isCommentAllowed(lnurl: string): Promise<{ allowed: boolean; maxLength?: number }> {
    try {
      const parsed = await this.parseLnurl(lnurl);
      
      const payData = parsed.type === 'pay' ? parsed.data : parsed.type === 'lnurlPay' ? parsed : parsed.type === 'lightningAddress' ? parsed.payRequest : null;
      if (!payData) {
        return { allowed: false };
      }
      return {
        allowed: !!payData.commentAllowed,
        maxLength: payData.commentAllowed
      };
    } catch (error) {
      console.error('Failed to check comment allowance:', error);
      return { allowed: false };
    }
  }
}
