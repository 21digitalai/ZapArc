// Breez SDK Spark wrapper for Lightning Network operations
// Handles wallet initialization, payments, and LNURL operations

import { Transaction, LightningAddressInfo } from '../types';
import * as bip39 from 'bip39';

export interface BreezConfig {
  network: 'mainnet' | 'regtest';
  apiKey?: string;
}

export interface InvoiceRequest {
  amountSats: number;
  description: string;
  expirySecs?: number;
}

export interface PaymentRequest {
  bolt11: string;
}

export interface LnurlPayRequest {
  reqData: any;
  amountSats: number;
  comment?: string;
}

export interface LnurlPayResult {
  success: boolean;
  paymentId?: string;
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
}

export class BreezSDKWrapper {
  private sdk: any = null;
  private isInitialized = false;
  private isConnected = false;

  /**
   * Initialize Breez SDK WASM module
   */
  async initializeSDK(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Dynamic import to handle WASM loading
      const breezModule = await import('@breeztech/breez-sdk-spark');
      
      // Initialize WASM
      await breezModule.default();
      console.log('Breez SDK WASM initialized successfully');
      
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize Breez SDK:', error);
      throw new Error(`Breez SDK initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Connect to Breez SDK with wallet configuration
   */
  async connectWallet(mnemonic?: string, config: BreezConfig = { network: 'mainnet' }): Promise<void> {
    if (!this.isInitialized) {
      await this.initializeSDK();
    }

    try {
      const { connect, defaultConfig } = await import('@breeztech/breez-sdk-spark');

      // Configure Breez SDK
      const breezConfig = defaultConfig(config.network);
      if (config.apiKey) {
        breezConfig.apiKey = config.apiKey;
      }

      // Generate mnemonic if not provided
      const walletMnemonic = mnemonic || bip39.generateMnemonic();

      // Connect to Breez SDK
      this.sdk = await connect({
        config: breezConfig,
        seed: { type: 'mnemonic', mnemonic: walletMnemonic },
        storageDir: 'breez_lightning_data'
      });

      this.isConnected = true;
      console.log('Breez SDK wallet connected successfully');
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      throw new Error(`Wallet connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if wallet is connected
   */
  isWalletConnected(): boolean {
    return this.isConnected && this.sdk !== null;
  }

  /**
   * Get wallet balance in satoshis
   */
  async getBalance(): Promise<number> {
    this.ensureConnected();

    try {
      const info = await this.sdk.getInfo({ ensureSynced: false });
      return info.balanceSats || 0;
    } catch (error) {
      console.error('Failed to get balance:', error);
      throw new Error(`Balance retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate Lightning invoice for receiving payments
   */
  async receivePayment(request: InvoiceRequest): Promise<string> {
    this.ensureConnected();

    try {
      const response = await this.sdk.receivePayment({
        paymentMethod: {
          type: 'bolt11Invoice',
          description: request.description || '',
          amountSats: request.amountSats,
          expirySecs: request.expirySecs
        }
      });
      return response.paymentRequest;
    } catch (error) {
      console.error('Failed to generate invoice:', error);
      throw new Error(`Invoice generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate an on-chain Bitcoin receive address
   */
  async receiveOnchain(): Promise<string> {
    this.ensureConnected();

    try {
      const response = await this.sdk.receivePayment({
        paymentMethod: {
          type: 'bitcoinAddress'
        }
      });

      return (response as any)?.paymentRequest || '';
    } catch (error) {
      console.error('Failed to generate on-chain receive address:', error);
      throw new Error(`On-chain address generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Send Lightning payment using bolt11 invoice
   */
  async sendPayment(request: PaymentRequest): Promise<boolean> {
    this.ensureConnected();

    try {
      const prepared = await this.sdk.prepareSendPayment({ paymentRequest: request.bolt11 });
      await this.sdk.sendPayment({ prepareResponse: prepared });
      return true;
    } catch (error) {
      console.error('Failed to send payment:', error);
      throw new Error(`Payment failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get payment history
   */
  async listPayments(): Promise<Transaction[]> {
    this.ensureConnected();

    try {
      const response = await this.sdk.listPayments({});
      return (response.payments || []).map((payment: any) => ({
        id: payment.id,
        type: payment.paymentType === 'send' ? 'send' : 'receive',
        amount: Number(payment.amount || 0),
        description: payment.description || '',
        timestamp: payment.timestamp || 0,
        status: this.mapPaymentStatus(payment.status)
      }));
    } catch (error) {
      console.error('Failed to list payments:', error);
      throw new Error(`Payment history retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Parse LNURL string
   */
  async parseLnurl(lnurl: string): Promise<any> {
    this.ensureConnected();

    try {
      return await this.sdk.parse(lnurl);
    } catch (error) {
      console.error('Failed to parse LNURL:', error);
      throw new Error(`LNURL parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Pay LNURL-pay request using the two-step flow (prepareLnurlPay → lnurlPay)
   * Returns confirmed payment result - the promise resolves only after payment is confirmed
   */
  async payLnurl(request: LnurlPayRequest): Promise<LnurlPayResult> {
    this.ensureConnected();

    try {
      // Step 1: Prepare the LNURL payment (gets invoice, calculates fees)
      console.log('[BreezSDK] Preparing LNURL payment...', {
        amountSats: request.amountSats,
        hasComment: !!request.comment
      });

      const prepareResponse = await this.sdk.prepareLnurlPay({
        amountSats: request.amountSats,
        payRequest: request.reqData,
        comment: request.comment || undefined,
        validateSuccessActionUrl: true
      });

      console.log('[BreezSDK] Payment prepared:', {
        amountSats: prepareResponse.amountSats,
        feeSats: prepareResponse.feeSats,
        hasSuccessAction: !!prepareResponse.successAction
      });

      // Step 2: Execute the payment - this waits for confirmation
      console.log('[BreezSDK] Executing LNURL payment...');
      const result = await this.sdk.lnurlPay({
        prepareResponse: prepareResponse
      });

      // Payment confirmed! Extract result details
      console.log('[BreezSDK] Payment confirmed:', {
        paymentId: result.payment?.id,
        status: result.payment?.status,
        hasSuccessAction: !!result.successAction
      });

      // Build success result with payment details
      const payResult: LnurlPayResult = {
        success: true,
        paymentId: result.payment?.id,
        paymentHash: result.payment?.details?.paymentHash,
        preimage: result.payment?.details?.preimage,
        amountSats: result.payment?.amountSats || request.amountSats,
        feeSats: result.payment?.fees || prepareResponse.feeSats
      };

      // Include success action if present
      if (result.successAction) {
        payResult.successAction = {
          type: result.successAction.type,
          message: result.successAction.data?.message,
          url: result.successAction.data?.url,
          description: result.successAction.data?.description
        };
      }

      return payResult;

    } catch (error) {
      console.error('[BreezSDK] LNURL payment failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'LNURL payment failed'
      };
    }
  }

  /**
   * Check if a Lightning Address username is available
   */
  async checkLightningAddressAvailable(username: string): Promise<boolean> {
    this.ensureConnected();

    try {
      const normalizedUsername = username.trim().toLowerCase();
      const sdkAny = this.sdk as any;
      const available = await sdkAny.checkLightningAddressAvailable({ username: normalizedUsername });
      return Boolean(available);
    } catch (error) {
      console.warn('[BreezSDK] checkLightningAddressAvailable failed (method may be unavailable):', error);
      throw new Error(`Failed to check username availability: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register a Lightning Address
   */
  async registerLightningAddress(username: string, description: string = ''): Promise<LightningAddressInfo> {
    this.ensureConnected();

    try {
      const normalizedUsername = username.trim().toLowerCase();
      const sdkAny = this.sdk as any;
      const result = await sdkAny.registerLightningAddress({
        username: normalizedUsername,
        description
      });

      return {
        lightningAddress: result?.lightningAddress || `${normalizedUsername}@breez.tips`,
        username: result?.username || normalizedUsername,
        description: result?.description || description || '',
        lnurl: result?.lnurl || ''
      };
    } catch (error) {
      console.warn('[BreezSDK] registerLightningAddress failed (method may be unavailable):', error);
      throw new Error(`Failed to register Lightning Address: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get currently registered Lightning Address
   */
  async getLightningAddress(): Promise<LightningAddressInfo | null> {
    this.ensureConnected();

    try {
      const sdkAny = this.sdk as any;
      const result = await sdkAny.getLightningAddress();
      if (!result || !result.lightningAddress) {
        return null;
      }

      return {
        lightningAddress: result.lightningAddress,
        username: result.username || result.lightningAddress.split('@')[0] || '',
        description: result.description || '',
        lnurl: result.lnurl || ''
      };
    } catch (error) {
      console.warn('[BreezSDK] getLightningAddress failed (method may be unavailable):', error);
      return null;
    }
  }

  /**
   * Unregister currently registered Lightning Address
   */
  async unregisterLightningAddress(): Promise<void> {
    this.ensureConnected();

    try {
      const sdkAny = this.sdk as any;
      if (typeof sdkAny.unregisterLightningAddress === 'function') {
        await sdkAny.unregisterLightningAddress();
      } else {
        await sdkAny.deleteLightningAddress();
      }
    } catch (error) {
      console.warn('[BreezSDK] unregisterLightningAddress failed (method may be unavailable):', error);
      throw new Error(`Failed to unregister Lightning Address: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate LNURL for receiving payments
   */
  async receiveLnurlPay(): Promise<string> {
    this.ensureConnected();

    try {
      const addressInfo = await this.sdk.getLightningAddress();
      return addressInfo?.lnurl?.bech32 || addressInfo?.lightningAddress || '';
    } catch (error) {
      console.error('Failed to generate receive LNURL:', error);
      throw new Error(`LNURL generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get node information
   */
  async getNodeInfo(): Promise<any> {
    this.ensureConnected();

    try {
      return await this.sdk.getInfo({ ensureSynced: false });
    } catch (error) {
      console.error('Failed to get node info:', error);
      throw new Error(`Node info retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Disconnect wallet
   */
  async disconnect(): Promise<void> {
    if (this.sdk) {
      try {
        await this.sdk.disconnect();
        this.sdk = null;
        this.isConnected = false;
        console.log('Breez SDK wallet disconnected');
      } catch (error) {
        console.error('Failed to disconnect wallet:', error);
      }
    }
  }

  /**
   * Check if a wallet has been used (has balance or transaction history)
   * Temporarily connects to the wallet, checks for balance and payments, then disconnects
   * Used for sub-wallet discovery during import
   *
   * Note: Breez SDK Spark stores transaction history locally, so a fresh connection
   * may not show historical transactions. We primarily check for balance which
   * is synced from the LSP and indicates wallet usage.
   */
  async checkWalletHasTransactions(
    mnemonic: string,
    config: BreezConfig = { network: 'mainnet' }
  ): Promise<{ hasTransactions: boolean; transactionCount: number; balanceSats: number }> {
    console.log('[BreezSDK] checkWalletHasTransactions - Starting...');

    if (!this.isInitialized) {
      await this.initializeSDK();
    }

    // Save current state if already connected
    const wasConnected = this.isConnected;
    const previousSdk = this.sdk;

    try {
      const { connect, defaultConfig } = await import('@breeztech/breez-sdk-spark');

      // Configure Breez SDK
      const breezConfig = defaultConfig(config.network);
      if (config.apiKey) {
        breezConfig.apiKey = config.apiKey;
      }

      console.log('[BreezSDK] checkWalletHasTransactions - Connecting to wallet...');

      // Connect with the provided mnemonic using a unique storage dir
      // Use a timeout to prevent hanging
      const connectPromise = connect({
        config: breezConfig,
        seed: { type: 'mnemonic', mnemonic: mnemonic },
        storageDir: `breez_discovery_${Date.now()}`
      });
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 5000)
      );
      
      const tempSdk = await Promise.race([connectPromise, timeoutPromise]) as any;

      console.log('[BreezSDK] checkWalletHasTransactions - Connected, checking wallet state...');

      // Check for balance and payments
      let hasActivity = false;
      let transactionCount = 0;
      let balanceSats = 0;

      try {
        // Get node info to check balance - this syncs with LSP
        // Use timeout to prevent hanging
        const infoPromise = tempSdk.getInfo({ ensureSynced: false });
        const infoTimeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Node info timeout')), 3000)
        );
        
        const info = await Promise.race([infoPromise, infoTimeout]) as any;
        balanceSats = info.balanceSats || 0;

        console.log('[BreezSDK] checkWalletHasTransactions - Info:', {
          balance: info.balanceSats,
          totalBalance: balanceSats
        });

        // If there's any balance, this wallet was definitely used
        if (balanceSats > 0) {
          hasActivity = true;
          console.log(`[BreezSDK] checkWalletHasTransactions - Wallet has balance: ${balanceSats} sats`);
        }
      } catch (nodeError) {
        console.warn('[BreezSDK] checkWalletHasTransactions - Could not get node info:', nodeError);
      }

      // Also check payments (may be empty for fresh storage, but worth checking)
      try {
        const paymentsResponse = await tempSdk.listPayments({});
        transactionCount = (paymentsResponse.payments || []).length;
        if (transactionCount > 0) {
          hasActivity = true;
        }
        console.log(`[BreezSDK] checkWalletHasTransactions - Found ${transactionCount} payments in local storage`);
      } catch (paymentError) {
        console.warn('[BreezSDK] checkWalletHasTransactions - Could not check payments:', paymentError);
      }

      // Disconnect the temporary connection
      console.log('[BreezSDK] checkWalletHasTransactions - Disconnecting...');
      try {
        await tempSdk.disconnect();
      } catch (disconnectError) {
        console.warn('[BreezSDK] checkWalletHasTransactions - Disconnect error (ignoring):', disconnectError);
      }

      console.log(`[BreezSDK] checkWalletHasTransactions - Result: hasActivity=${hasActivity}, balance=${balanceSats}, payments=${transactionCount}`);
      return { hasTransactions: hasActivity, transactionCount, balanceSats };
    } catch (error) {
      console.error('[BreezSDK] checkWalletHasTransactions - Failed:', error);
      // On error, return no activity found
      return { hasTransactions: false, transactionCount: 0, balanceSats: 0 };
    } finally {
      // Restore previous state
      this.sdk = previousSdk;
      this.isConnected = wasConnected;
    }
  }

  /**
   * Ensure wallet is connected before operations
   */
  private ensureConnected(): void {
    if (!this.isConnected || !this.sdk) {
      throw new Error('Wallet not connected. Please initialize wallet first.');
    }
  }

  /**
   * Map Breez SDK payment status to our Transaction status
   */
  private mapPaymentStatus(breezStatus: string): 'pending' | 'completed' | 'failed' {
    switch (breezStatus?.toLowerCase()) {
      case 'complete':
      case 'succeeded':
        return 'completed';
      case 'pending':
      case 'in_flight':
        return 'pending';
      case 'failed':
      case 'canceled':
        return 'failed';
      default:
        return 'pending';
    }
  }
}
