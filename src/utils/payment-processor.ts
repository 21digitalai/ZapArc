// Payment Processor for ZapArc wallet payments
// Handles payment workflows, status tracking, error handling, and retry mechanisms

import { ExtensionMessaging, MessageResponse } from './messaging';
import { convertToLnurl, isLightningAddress } from './lnurl';

export interface PaymentOptions {
  lnurl: string;
  amount: number;
  comment?: string;
  useBuiltInWallet?: boolean;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  paymentHash?: string;
  preimage?: string;
  amountSats?: number;
  feeSats?: number;
  successAction?: {
    type: 'message' | 'url' | 'aes';
    message?: string;
    url?: string;
    description?: string;
  };
  error?: string;
  retryable?: boolean;
}

export interface PaymentStatus {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  amount: number;
  lnurl: string;
  comment?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
  timestamp: number;
  lastRetry?: number;
}

export class PaymentProcessor {
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAYS = [1000, 3000, 5000]; // Progressive delays in ms
  private static readonly PAYMENT_TIMEOUT = 30000; // 30 seconds

  private activePayments = new Map<string, PaymentStatus>();
  private paymentCallbacks = new Map<string, (status: PaymentStatus) => void>();

  /**
   * Process payment with full workflow including confirmation and status tracking
   */
  async processPayment(options: PaymentOptions): Promise<PaymentResult> {
    const paymentId = this.generatePaymentId();

    try {
      // Initialize payment status
      const paymentStatus: PaymentStatus = {
        id: paymentId,
        status: 'pending',
        amount: options.amount,
        lnurl: options.lnurl,
        comment: options.comment,
        retryCount: 0,
        maxRetries: PaymentProcessor.MAX_RETRIES,
        timestamp: Date.now()
      };

      this.activePayments.set(paymentId, paymentStatus);
      this.notifyStatusChange(paymentStatus);

      // Check wallet connection and balance
      const preflightResult = await this.preflightChecks(options);
      if (!preflightResult.success) {
        paymentStatus.status = 'failed';
        paymentStatus.error = preflightResult.error;
        this.activePayments.set(paymentId, paymentStatus);
        this.notifyStatusChange(paymentStatus);
        return preflightResult;
      }

      // Parse LNURL and validate payment parameters
      const lnurlData = await this.parseLnurlWithValidation(options.lnurl);
      if (!lnurlData.success) {
        paymentStatus.status = 'failed';
        paymentStatus.error = lnurlData.error;
        this.activePayments.set(paymentId, paymentStatus);
        this.notifyStatusChange(paymentStatus);
        return { success: false, error: lnurlData.error };
      }

      // Validate amount against LNURL limits
      const validationResult = this.validatePaymentAmount(options.amount, lnurlData.data);
      if (!validationResult.success) {
        paymentStatus.status = 'failed';
        paymentStatus.error = validationResult.error;
        this.activePayments.set(paymentId, paymentStatus);
        this.notifyStatusChange(paymentStatus);
        return validationResult;
      }

      // Execute payment with retry logic
      paymentStatus.status = 'processing';
      this.activePayments.set(paymentId, paymentStatus);
      this.notifyStatusChange(paymentStatus);

      const paymentResult = await this.executePaymentWithRetry(paymentId, lnurlData.data, options);

      // Update final status
      paymentStatus.status = paymentResult.success ? 'completed' : 'failed';
      if (!paymentResult.success) {
        paymentStatus.error = paymentResult.error;
      }
      this.activePayments.set(paymentId, paymentStatus);
      this.notifyStatusChange(paymentStatus);

      // Clean up after delay
      setTimeout(() => {
        this.activePayments.delete(paymentId);
        this.paymentCallbacks.delete(paymentId);
      }, 60000); // Keep for 1 minute for status queries

      return paymentResult;

    } catch (error) {
      const paymentStatus = this.activePayments.get(paymentId);
      if (paymentStatus) {
        paymentStatus.status = 'failed';
        paymentStatus.error = error instanceof Error ? error.message : 'Unknown error';
        this.activePayments.set(paymentId, paymentStatus);
        this.notifyStatusChange(paymentStatus);
      }

      console.error('Payment processing error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Payment processing failed'
      };
    }
  }

  /**
   * Generate QR code for external wallet payment
   */
  async generatePaymentQR(options: PaymentOptions): Promise<MessageResponse<string>> {
    try {
      // Parse LNURL to get payment request data
      const lnurlResponse = await ExtensionMessaging.parseLnurl(options.lnurl);
      if (!lnurlResponse.success || !lnurlResponse.data) {
        return {
          success: false,
          error: 'Failed to parse LNURL for QR generation'
        };
      }

      const lnurlData = lnurlResponse.data;

      // Validate amount
      const validationResult = this.validatePaymentAmount(options.amount, lnurlData);
      if (!validationResult.success) {
        return {
          success: false,
          error: validationResult.error
        };
      }

      // For QR code, we can either:
      // 1. Return the LNURL directly for wallet scanning
      // 2. Generate a bolt11 invoice if the LNURL service supports it

      // For now, return the LNURL - most Lightning wallets can scan LNURL QR codes
      return {
        success: true,
        data: options.lnurl
      };

    } catch (error) {
      console.error('QR generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'QR generation failed'
      };
    }
  }

  /**
   * Get payment status by ID
   */
  getPaymentStatus(paymentId: string): PaymentStatus | null {
    return this.activePayments.get(paymentId) || null;
  }

  /**
   * Subscribe to payment status updates
   */
  onPaymentStatusChange(paymentId: string, callback: (status: PaymentStatus) => void): void {
    this.paymentCallbacks.set(paymentId, callback);
  }

  /**
   * Cancel active payment
   */
  cancelPayment(paymentId: string): boolean {
    const payment = this.activePayments.get(paymentId);
    if (payment && payment.status === 'pending') {
      payment.status = 'cancelled';
      this.activePayments.set(paymentId, payment);
      this.notifyStatusChange(payment);
      return true;
    }
    return false;
  }

  /**
   * Retry failed payment
   */
  async retryPayment(paymentId: string): Promise<PaymentResult> {
    const payment = this.activePayments.get(paymentId);
    if (!payment || payment.status !== 'failed') {
      return {
        success: false,
        error: 'Payment not found or not in failed state'
      };
    }

    if (payment.retryCount >= payment.maxRetries) {
      return {
        success: false,
        error: 'Maximum retry attempts exceeded'
      };
    }

    // Reset status and retry
    payment.status = 'processing';
    payment.retryCount++;
    payment.lastRetry = Date.now();
    this.activePayments.set(paymentId, payment);
    this.notifyStatusChange(payment);

    const options: PaymentOptions = {
      lnurl: payment.lnurl,
      amount: payment.amount,
      comment: payment.comment,
      useBuiltInWallet: true
    };

    // Parse LNURL again (in case it changed)
    const lnurlResponse = await ExtensionMessaging.parseLnurl(payment.lnurl);
    if (!lnurlResponse.success) {
      payment.status = 'failed';
      payment.error = 'Failed to parse LNURL on retry';
      this.activePayments.set(paymentId, payment);
      this.notifyStatusChange(payment);
      return { success: false, error: payment.error };
    }

    const result = await this.executePayment(lnurlResponse.data, options);

    payment.status = result.success ? 'completed' : 'failed';
    if (!result.success) {
      payment.error = result.error;
    }
    this.activePayments.set(paymentId, payment);
    this.notifyStatusChange(payment);

    return result;
  }

  /**
   * Perform preflight checks before payment
   */
  private async preflightChecks(options: PaymentOptions): Promise<PaymentResult> {
    try {
      // Check if wallet is connected (for built-in wallet payments)
      if (options.useBuiltInWallet !== false) {
        const walletConnected = await ExtensionMessaging.isWalletConnected();
        if (!walletConnected.success || !walletConnected.data) {
          return {
            success: false,
            error: 'Wallet not connected. Please unlock your wallet first.',
            retryable: true
          };
        }

        // Check wallet balance
        const balanceResponse = await ExtensionMessaging.getBalance();
        if (!balanceResponse.success) {
          return {
            success: false,
            error: 'Failed to check wallet balance',
            retryable: true
          };
        }

        const balance = balanceResponse.data || 0;
        const estimatedFee = Math.max(1, Math.floor(options.amount * 0.001));
        const totalRequired = options.amount + estimatedFee;

        if (balance < totalRequired) {
          return {
            success: false,
            error: `Insufficient balance. Need ${totalRequired.toLocaleString()} sats, have ${balance.toLocaleString()} sats.`,
            retryable: false
          };
        }
      }

      return { success: true };

    } catch (error) {
      console.error('Preflight check error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Preflight checks failed',
        retryable: true
      };
    }
  }

  /**
   * Parse LNURL or Lightning address with comprehensive validation
   */
  private async parseLnurlWithValidation(lnurl: string): Promise<MessageResponse<any>> {
    try {
      // Convert Lightning address to LNURL endpoint if needed
      const resolvedLnurl = convertToLnurl(lnurl);

      const response = await ExtensionMessaging.parseLnurl(resolvedLnurl);

      if (!response.success || !response.data) {
        return {
          success: false,
          error: 'Invalid LNURL/Lightning address or service unavailable'
        };
      }

      const lnurlData = response.data;

      // Validate that it's a pay request
      if (lnurlData.type !== 'pay') {
        return {
          success: false,
          error: 'LNURL is not a payment request'
        };
      }

      // Check if service is reachable
      if (!lnurlData.data || !lnurlData.data.callback) {
        return {
          success: false,
          error: 'Invalid LNURL payment data'
        };
      }

      return {
        success: true,
        data: lnurlData.data
      };

    } catch (error) {
      console.error('LNURL parsing error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'LNURL parsing failed'
      };
    }
  }

  /**
   * Validate payment amount against LNURL limits
   */
  private validatePaymentAmount(amount: number, lnurlData: any): PaymentResult {
    if (!lnurlData.minSendable || !lnurlData.maxSendable) {
      return {
        success: false,
        error: 'LNURL service did not provide payment limits'
      };
    }

    // Convert from millisats to sats
    const minSats = Math.floor(lnurlData.minSendable / 1000);
    const maxSats = Math.floor(lnurlData.maxSendable / 1000);

    if (amount < minSats) {
      return {
        success: false,
        error: `Amount too small. Minimum: ${minSats.toLocaleString()} sats`
      };
    }

    if (amount > maxSats) {
      return {
        success: false,
        error: `Amount too large. Maximum: ${maxSats.toLocaleString()} sats`
      };
    }

    return { success: true };
  }

  /**
   * Execute payment with retry logic
   */
  private async executePaymentWithRetry(
    paymentId: string,
    lnurlData: any,
    options: PaymentOptions
  ): Promise<PaymentResult> {
    const payment = this.activePayments.get(paymentId);
    if (!payment) {
      return { success: false, error: 'Payment not found' };
    }

    let lastError: string = '';

    for (let attempt = 0; attempt <= PaymentProcessor.MAX_RETRIES; attempt++) {
      try {
        // Update retry count
        payment.retryCount = attempt;
        payment.lastRetry = Date.now();
        this.activePayments.set(paymentId, payment);
        this.notifyStatusChange(payment);

        // Execute payment
        const result = await this.executePayment(lnurlData, options);

        if (result.success) {
          return result;
        }

        lastError = result.error || 'Unknown error';

        // Check if error is retryable
        if (!result.retryable || attempt >= PaymentProcessor.MAX_RETRIES) {
          break;
        }

        // Wait before retry
        if (attempt < PaymentProcessor.MAX_RETRIES) {
          await this.delay(PaymentProcessor.RETRY_DELAYS[attempt] || 5000);
        }

      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Payment execution failed';

        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          break;
        }

        if (attempt < PaymentProcessor.MAX_RETRIES) {
          await this.delay(PaymentProcessor.RETRY_DELAYS[attempt] || 5000);
        }
      }
    }

    return {
      success: false,
      error: `Payment failed after ${PaymentProcessor.MAX_RETRIES + 1} attempts: ${lastError}`,
      retryable: false
    };
  }

  /**
   * Execute single payment attempt
   */
  private async executePayment(lnurlData: any, options: PaymentOptions): Promise<PaymentResult> {
    try {
      // Create timeout promise
      const timeoutPromise = new Promise<PaymentResult>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Payment timeout'));
        }, PaymentProcessor.PAYMENT_TIMEOUT);
      });

      // Create payment promise
      const paymentPromise = this.performPayment(lnurlData, options);

      // Race between payment and timeout
      const result = await Promise.race([paymentPromise, timeoutPromise]);

      return result;

    } catch (error) {
      console.error('Payment execution error:', error);

      const errorMessage = error instanceof Error ? error.message : 'Payment failed';
      const isRetryable = this.isRetryableError(error);

      return {
        success: false,
        error: errorMessage,
        retryable: isRetryable
      };
    }
  }

  /**
   * Perform the actual payment via Breez SDK
   * The SDK waits for payment confirmation before resolving
   */
  private async performPayment(lnurlData: any, options: PaymentOptions): Promise<PaymentResult> {
    try {
      const response = await ExtensionMessaging.payLnurl(
        lnurlData,
        options.amount,
        options.comment
      );

      if (response.success && response.data) {
        // Payment confirmed - extract rich result data
        const paymentData = response.data;
        return {
          success: true,
          transactionId: paymentData.paymentId,
          paymentHash: paymentData.paymentHash,
          preimage: paymentData.preimage,
          amountSats: paymentData.amountSats,
          feeSats: paymentData.feeSats,
          successAction: paymentData.successAction
        };
      } else {
        return {
          success: false,
          error: response.error || 'Payment failed',
          retryable: this.isRetryableError(new Error(response.error || ''))
        };
      }

    } catch (error) {
      console.error('LNURL payment error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Payment execution failed',
        retryable: this.isRetryableError(error)
      };
    }
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message || error.toString() || '';
    const lowerMessage = errorMessage.toLowerCase();

    // Network-related errors are usually retryable
    const retryablePatterns = [
      'network',
      'timeout',
      'connection',
      'temporary',
      'service unavailable',
      'try again',
      'rate limit',
      'busy'
    ];

    return retryablePatterns.some(pattern => lowerMessage.includes(pattern));
  }

  /**
   * Check if error should never be retried
   */
  private isNonRetryableError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message || error.toString() || '';
    const lowerMessage = errorMessage.toLowerCase();

    // These errors should not be retried
    const nonRetryablePatterns = [
      'insufficient',
      'invalid',
      'unauthorized',
      'forbidden',
      'not found',
      'malformed',
      'expired',
      'cancelled'
    ];

    return nonRetryablePatterns.some(pattern => lowerMessage.includes(pattern));
  }

  /**
   * Generate unique payment ID
   */
  private generatePaymentId(): string {
    return `payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Notify status change to subscribers
   */
  private notifyStatusChange(status: PaymentStatus): void {
    const callback = this.paymentCallbacks.get(status.id);
    if (callback) {
      try {
        callback(status);
      } catch (error) {
        console.error('Payment status callback error:', error);
      }
    }
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get all active payments
   */
  getActivePayments(): PaymentStatus[] {
    return Array.from(this.activePayments.values());
  }

  /**
   * Clear completed payments
   */
  clearCompletedPayments(): void {
    for (const [id, payment] of this.activePayments.entries()) {
      if (payment.status === 'completed' || payment.status === 'cancelled') {
        this.activePayments.delete(id);
        this.paymentCallbacks.delete(id);
      }
    }
  }
}

// Global payment processor instance
export const paymentProcessor = new PaymentProcessor();
