// QR Code Generator for ZapArc Lightning payments
// Generates QR codes for Lightning payments and LNURL-pay requests

import * as QRCode from 'qrcode';

export interface QRCodeOptions {
  data: string;
  size?: number;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  margin?: number;
  color?: {
    dark?: string;
    light?: string;
  };
}

export interface QRCodeResult {
  success: boolean;
  dataUrl?: string;
  svg?: string;
  error?: string;
}

export class QRCodeGenerator {
  private static readonly DEFAULT_SIZE = 200;
  private static readonly DEFAULT_MARGIN = 4;
  private static readonly DEFAULT_ERROR_CORRECTION = 'M';

  /**
   * Generate QR code for Lightning payment
   * Supports both LNURL and bolt11 invoices
   */
  static async generatePaymentQR(
    paymentData: string,
    options: Partial<QRCodeOptions> = {}
  ): Promise<QRCodeResult> {
    try {
      // Validate payment data
      if (!paymentData || typeof paymentData !== 'string') {
        return {
          success: false,
          error: 'Invalid payment data'
        };
      }

      // Determine payment type and format
      const formattedData = this.formatPaymentData(paymentData);
      
      // Generate QR code using canvas-based approach
      const qrResult = await this.generateQRCode(formattedData, {
        data: formattedData,
        size: options.size || this.DEFAULT_SIZE,
        errorCorrectionLevel: options.errorCorrectionLevel || this.DEFAULT_ERROR_CORRECTION,
        margin: options.margin || this.DEFAULT_MARGIN,
        color: options.color || { dark: '#000000', light: '#ffffff' }
      });

      return qrResult;

    } catch (error) {
      console.error('QR code generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'QR generation failed'
      };
    }
  }

  /**
   * Generate QR code with Lightning URI format
   */
  static async generateLightningURI(
    paymentData: string,
    amount?: number,
    message?: string,
    options: Partial<QRCodeOptions> = {}
  ): Promise<QRCodeResult> {
    try {
      let uri = '';

      if (paymentData.toLowerCase().startsWith('lnurl')) {
        // LNURL format
        uri = `lightning:${paymentData.toUpperCase()}`;
        
        // Add amount parameter if specified
        if (amount && amount > 0) {
          uri += `?amount=${amount * 1000}`; // Convert sats to millisats
        }
        
        // Add message parameter if specified
        if (message) {
          const separator = uri.includes('?') ? '&' : '?';
          uri += `${separator}message=${encodeURIComponent(message)}`;
        }
      } else if (paymentData.toLowerCase().startsWith('lnbc') || paymentData.toLowerCase().startsWith('lntb')) {
        // Bolt11 invoice
        uri = `lightning:${paymentData}`;
      } else {
        // Assume it's already a proper URI or raw data
        uri = paymentData;
      }

      return await this.generatePaymentQR(uri, options);

    } catch (error) {
      console.error('Lightning URI generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Lightning URI generation failed'
      };
    }
  }

  /**
   * Format payment data for QR code
   */
  private static formatPaymentData(data: string): string {
    const lowerData = data.toLowerCase();

    // If it's already a lightning URI, return as-is
    if (lowerData.startsWith('lightning:')) {
      return data;
    }

    // If it's an LNURL, format as lightning URI
    if (lowerData.startsWith('lnurl')) {
      return `lightning:${data.toUpperCase()}`;
    }

    // If it's a bolt11 invoice, format as lightning URI
    if (lowerData.startsWith('lnbc') || lowerData.startsWith('lntb')) {
      return `lightning:${data}`;
    }

    // Return as-is for other formats
    return data;
  }

  /**
   * Generate QR code using the qrcode library
   */
  private static async generateQRCode(
    data: string,
    options: QRCodeOptions
  ): Promise<QRCodeResult> {
    try {
      const size = options.size || this.DEFAULT_SIZE;
      const margin = options.margin || this.DEFAULT_MARGIN;
      const errorCorrectionLevel = options.errorCorrectionLevel || this.DEFAULT_ERROR_CORRECTION;
      
      // Generate QR code as data URL
      const qrOptions = {
        width: size,
        margin: margin,
        color: {
          dark: options.color?.dark || '#000000',
          light: options.color?.light || '#ffffff'
        },
        errorCorrectionLevel: errorCorrectionLevel
      };

      const dataUrl = await QRCode.toDataURL(data, qrOptions);

      return {
        success: true,
        dataUrl: dataUrl
      };

    } catch (error) {
      console.error('QR code generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'QR code generation failed'
      };
    }
  }

  /**
   * Generate SVG QR code using qrcode library
   */
  static async generateSVGQR(
    data: string,
    options: Partial<QRCodeOptions> = {}
  ): Promise<QRCodeResult> {
    try {
      const size = options.size || this.DEFAULT_SIZE;
      const margin = options.margin || this.DEFAULT_MARGIN;
      const errorCorrectionLevel = options.errorCorrectionLevel || this.DEFAULT_ERROR_CORRECTION;
      
      const qrOptions = {
        width: size,
        margin: margin,
        color: {
          dark: options.color?.dark || '#000000',
          light: options.color?.light || '#ffffff'
        },
        errorCorrectionLevel: errorCorrectionLevel
      };

      const svg = await QRCode.toString(data, { 
        ...qrOptions, 
        type: 'svg' as const 
      });

      return {
        success: true,
        svg: svg
      };

    } catch (error) {
      console.error('SVG QR generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'SVG QR generation failed'
      };
    }
  }

  /**
   * Validate Lightning payment data
   */
  static validatePaymentData(data: string): { valid: boolean; type?: string; error?: string } {
    if (!data || typeof data !== 'string') {
      return { valid: false, error: 'Invalid data format' };
    }

    const lowerData = data.toLowerCase();

    // Check for LNURL
    if (lowerData.startsWith('lnurl')) {
      return { valid: true, type: 'lnurl' };
    }

    // Check for bolt11 invoice
    if (lowerData.startsWith('lnbc') || lowerData.startsWith('lntb')) {
      return { valid: true, type: 'bolt11' };
    }

    // Check for lightning URI
    if (lowerData.startsWith('lightning:')) {
      return { valid: true, type: 'lightning_uri' };
    }

    // Check for Bitcoin address (for fallback)
    if (/^[13][a-km-z1-9]{25,34}$/i.test(data) || /^bc1[a-z0-9]{39,59}$/i.test(data)) {
      return { valid: true, type: 'bitcoin_address' };
    }

    return { valid: false, error: 'Unrecognized payment format' };
  }

  /**
   * Get QR code size recommendations based on data length
   */
  static getRecommendedSize(data: string): number {
    const length = data.length;
    
    if (length < 50) return 150;
    if (length < 100) return 200;
    if (length < 200) return 250;
    if (length < 300) return 300;
    return 350;
  }

  /**
   * Simple hash function for placeholder pattern
   */
  private static simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Create QR code with error handling and fallback
   */
  static async createQRWithFallback(
    data: string,
    options: Partial<QRCodeOptions> = {}
  ): Promise<QRCodeResult> {
    // Try canvas-based generation first
    const canvasResult = await this.generatePaymentQR(data, options);
    if (canvasResult.success) {
      return canvasResult;
    }

    // Fallback to SVG generation
    console.warn('Canvas QR generation failed, trying SVG fallback');
    const svgResult = await this.generateSVGQR(data, options);
    if (svgResult.success) {
      return svgResult;
    }

    // Final fallback - return error
    return {
      success: false,
      error: 'All QR generation methods failed'
    };
  }
}

// Export utility functions
export const qrGenerator = QRCodeGenerator;
