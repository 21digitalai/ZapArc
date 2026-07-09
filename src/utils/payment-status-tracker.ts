// Payment Status Tracker for ZapArc wallet payments
// Provides real-time payment status updates and user feedback

import { PaymentStatus } from './payment-processor';

export interface PaymentNotification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  duration?: number;
  actions?: NotificationAction[];
}

export interface NotificationAction {
  label: string;
  action: () => void;
  style?: 'primary' | 'secondary' | 'danger';
}

export interface StatusDisplayOptions {
  showProgress?: boolean;
  showRetryButton?: boolean;
  showCancelButton?: boolean;
  compact?: boolean;
}

export class PaymentStatusTracker {
  private static readonly NOTIFICATION_DURATION = 5000;
  private static readonly SUCCESS_DURATION = 3000;
  private static readonly ERROR_DURATION = 8000;

  private notifications = new Map<string, PaymentNotification>();
  private statusElements = new Map<string, HTMLElement>();

  /**
   * Show payment status notification
   */
  showPaymentNotification(payment: PaymentStatus): void {
    const notification = this.createPaymentNotification(payment);
    this.displayNotification(notification);
  }

  /**
   * Create status display element for payment
   */
  createStatusDisplay(
    payment: PaymentStatus,
    options: StatusDisplayOptions = {}
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'lightning-payment-status';
    container.setAttribute('data-payment-id', payment.id);
    
    const baseStyles = `
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      border-radius: 8px;
      padding: ${options.compact ? '8px 12px' : '12px 16px'};
      margin: 8px 0;
      border: 1px solid;
      font-size: ${options.compact ? '12px' : '14px'};
      transition: all 0.3s ease;
    `;

    container.style.cssText = baseStyles + this.getStatusStyles(payment.status);
    container.innerHTML = this.generateStatusHTML(payment, options);

    // Add event listeners
    this.setupStatusEventListeners(container, payment, options);

    // Store reference
    this.statusElements.set(payment.id, container);

    return container;
  }

  /**
   * Update existing status display
   */
  updateStatusDisplay(payment: PaymentStatus): void {
    const element = this.statusElements.get(payment.id);
    if (!element) return;

    // Update styles
    const baseStyles = element.style.cssText.split('border:')[0] + 'border: 1px solid;';
    element.style.cssText = baseStyles + this.getStatusStyles(payment.status);

    // Update content
    const statusText = element.querySelector('.status-text');
    const progressBar = element.querySelector('.progress-bar');
    const actionButtons = element.querySelector('.action-buttons');

    if (statusText) {
      statusText.textContent = this.getStatusText(payment);
    }

    if (progressBar) {
      this.updateProgressBar(progressBar as HTMLElement, payment);
    }

    if (actionButtons) {
      this.updateActionButtons(actionButtons as HTMLElement, payment);
    }

    // Auto-remove completed/failed notifications after delay
    if (payment.status === 'completed' || payment.status === 'failed') {
      setTimeout(() => {
        this.removeStatusDisplay(payment.id);
      }, payment.status === 'completed' ? 3000 : 8000);
    }
  }

  /**
   * Remove status display
   */
  removeStatusDisplay(paymentId: string): void {
    const element = this.statusElements.get(paymentId);
    if (element) {
      element.style.opacity = '0';
      element.style.transform = 'translateY(-10px)';
      setTimeout(() => {
        element.remove();
        this.statusElements.delete(paymentId);
      }, 300);
    }
  }

  /**
   * Show toast notification
   */
  showToast(notification: PaymentNotification): void {
    // Prevent duplicate toasts - check by ID or by title+message
    const existingById = document.querySelector(`[data-notification-id="${notification.id}"]`);
    if (existingById) {
      console.log(`[PaymentStatusTracker] Skipping duplicate toast by ID: ${notification.id}`);
      return;
    }
    
    // Also check by title+message to prevent spam from rapid clicks
    const existingToasts = Array.from(document.querySelectorAll('.lightning-toast-notification'));
    for (const toast of existingToasts) {
      const toastTitle = toast.querySelector('div > div > div:first-child')?.textContent;
      const toastMessage = toast.querySelector('div > div > div:nth-child(2)')?.textContent;
      if (toastTitle?.trim() === notification.title && toastMessage?.trim() === notification.message) {
        console.log(`[PaymentStatusTracker] Skipping duplicate toast by content: ${notification.title}`);
        return;
      }
    }
    
    const toast = this.createToastElement(notification);
    document.body.appendChild(toast);

    // Animate in
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    }, 10);

    // Auto-remove after duration
    const duration = notification.duration || this.getDefaultDuration(notification.type);
    setTimeout(() => {
      this.removeToast(toast);
    }, duration);
  }

  /**
   * Create payment notification based on status
   */
  private createPaymentNotification(payment: PaymentStatus): PaymentNotification {
    const baseNotification = {
      id: payment.id,
      title: '',
      message: '',
      actions: [] as NotificationAction[]
    };

    switch (payment.status) {
      case 'pending':
        return {
          ...baseNotification,
          type: 'info' as const,
          title: 'Payment Initiated',
          message: `Preparing to send ${payment.amount.toLocaleString()} sats...`
        };

      case 'processing':
        return {
          ...baseNotification,
          type: 'info' as const,
          title: 'Processing Payment',
          message: `Sending ${payment.amount.toLocaleString()} sats via Lightning Network...`,
          duration: 0 // Don't auto-dismiss
        };

      case 'completed':
        return {
          ...baseNotification,
          type: 'success' as const,
          title: 'Payment Successful! ⚡',
          message: `Successfully sent ${payment.amount.toLocaleString()} sats`,
          duration: PaymentStatusTracker.SUCCESS_DURATION
        };

      case 'failed':
        const retryAction: NotificationAction = {
          label: 'Retry',
          action: () => this.retryPayment(payment.id),
          style: 'primary'
        };

        return {
          ...baseNotification,
          type: 'error' as const,
          title: 'Payment Failed',
          message: payment.error || 'Payment could not be completed',
          duration: PaymentStatusTracker.ERROR_DURATION,
          actions: payment.retryCount < payment.maxRetries ? [retryAction] : []
        };

      case 'cancelled':
        return {
          ...baseNotification,
          type: 'warning' as const,
          title: 'Payment Cancelled',
          message: 'Payment was cancelled by user'
        };

      default:
        return {
          ...baseNotification,
          type: 'info' as const,
          title: 'Payment Status',
          message: `Payment status: ${payment.status}`
        };
    }
  }

  /**
   * Display notification using appropriate method
   */
  private displayNotification(notification: PaymentNotification): void {
    // Store notification
    this.notifications.set(notification.id, notification);

    // Show as toast
    this.showToast(notification);

    // Also log to console for debugging
    console.log(`Payment ${notification.id}: ${notification.title} - ${notification.message}`);
  }

  /**
   * Generate HTML for status display
   */
  private generateStatusHTML(payment: PaymentStatus, options: StatusDisplayOptions): string {
    const showProgress = options.showProgress && (payment.status === 'processing' || payment.status === 'pending');
    const showActions = (options.showRetryButton && payment.status === 'failed') || 
                       (options.showCancelButton && payment.status === 'pending');

    return `
      <div class="status-header" style="display: flex; align-items: center; margin-bottom: ${showProgress || showActions ? '8px' : '0'};">
        <span class="status-icon" style="margin-right: 8px; font-size: 16px;">
          ${this.getStatusIcon(payment.status)}
        </span>
        <span class="status-text" style="flex: 1; font-weight: 500;">
          ${this.getStatusText(payment)}
        </span>
        <span class="amount" style="font-weight: bold; color: #f7931a;">
          ${payment.amount.toLocaleString()} sats
        </span>
      </div>
      
      ${showProgress ? `
        <div class="progress-container" style="margin-bottom: 8px;">
          <div class="progress-bar" style="
            width: 100%;
            height: 4px;
            background: rgba(0,0,0,0.1);
            border-radius: 2px;
            overflow: hidden;
          ">
            <div class="progress-fill" style="
              height: 100%;
              background: #f7931a;
              border-radius: 2px;
              transition: width 0.3s ease;
              width: ${this.getProgressPercentage(payment)}%;
            "></div>
          </div>
        </div>
      ` : ''}
      
      ${payment.error ? `
        <div class="error-message" style="
          font-size: 12px;
          color: #f44336;
          margin-top: 4px;
          padding: 4px 8px;
          background: rgba(244, 67, 54, 0.1);
          border-radius: 4px;
        ">
          ${payment.error}
        </div>
      ` : ''}
      
      ${showActions ? `
        <div class="action-buttons" style="
          display: flex;
          gap: 8px;
          margin-top: 8px;
        ">
          ${options.showRetryButton && payment.status === 'failed' ? `
            <button class="retry-btn" style="
              flex: 1;
              padding: 6px 12px;
              border: 1px solid #f7931a;
              border-radius: 4px;
              background: white;
              color: #f7931a;
              cursor: pointer;
              font-size: 12px;
              font-weight: bold;
            ">Retry (${payment.maxRetries - payment.retryCount} left)</button>
          ` : ''}
          
          ${options.showCancelButton && payment.status === 'pending' ? `
            <button class="cancel-btn" style="
              padding: 6px 12px;
              border: 1px solid #666;
              border-radius: 4px;
              background: white;
              color: #666;
              cursor: pointer;
              font-size: 12px;
            ">Cancel</button>
          ` : ''}
        </div>
      ` : ''}
    `;
  }

  /**
   * Setup event listeners for status display
   */
  private setupStatusEventListeners(
    element: HTMLElement,
    payment: PaymentStatus,
    options: StatusDisplayOptions
  ): void {
    // Retry button
    const retryBtn = element.querySelector('.retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        this.retryPayment(payment.id);
      });
    }

    // Cancel button
    const cancelBtn = element.querySelector('.cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        this.cancelPayment(payment.id);
      });
    }
  }

  /**
   * Create toast notification element
   */
  private createToastElement(notification: PaymentNotification): HTMLElement {
    const toast = document.createElement('div');
    toast.className = 'lightning-toast-notification';
    toast.setAttribute('data-notification-id', notification.id);
    
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      max-width: 400px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      border-left: 4px solid ${this.getTypeColor(notification.type)};
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      z-index: 10001;
      opacity: 0;
      transform: translateX(100%);
      transition: all 0.3s ease;
    `;

    toast.innerHTML = `
      <div style="display: flex; align-items: flex-start;">
        <span style="font-size: 20px; margin-right: 12px;">
          ${this.getTypeIcon(notification.type)}
        </span>
        <div style="flex: 1;">
          <div style="font-weight: bold; margin-bottom: 4px; color: #333;">
            ${notification.title}
          </div>
          <div style="color: #666; line-height: 1.4;">
            ${notification.message}
          </div>
          ${notification.actions && notification.actions.length > 0 ? `
            <div style="margin-top: 12px; display: flex; gap: 8px;">
              ${notification.actions.map(action => `
                <button class="toast-action" data-action="${action.label}" style="
                  padding: 6px 12px;
                  border: 1px solid ${action.style === 'primary' ? '#f7931a' : '#ddd'};
                  border-radius: 4px;
                  background: ${action.style === 'primary' ? '#f7931a' : 'white'};
                  color: ${action.style === 'primary' ? 'white' : '#666'};
                  cursor: pointer;
                  font-size: 12px;
                  font-weight: bold;
                ">${action.label}</button>
              `).join('')}
            </div>
          ` : ''}
        </div>
        <button class="close-toast" style="
          background: none;
          border: none;
          font-size: 18px;
          cursor: pointer;
          color: #999;
          padding: 0;
          margin-left: 8px;
        ">×</button>
      </div>
    `;

    // Add event listeners
    toast.querySelector('.close-toast')?.addEventListener('click', () => {
      this.removeToast(toast);
    });

    // Action buttons
    notification.actions?.forEach(action => {
      const btn = toast.querySelector(`[data-action="${action.label}"]`);
      if (btn) {
        btn.addEventListener('click', () => {
          action.action();
          this.removeToast(toast);
        });
      }
    });

    return toast;
  }

  /**
   * Remove toast notification
   */
  private removeToast(toast: HTMLElement): void {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }

  /**
   * Get status-specific styles
   */
  private getStatusStyles(status: string): string {
    switch (status) {
      case 'pending':
        return 'border-color: #2196F3; background: #e3f2fd; color: #1976d2;';
      case 'processing':
        return 'border-color: #ff9800; background: #fff3e0; color: #f57c00;';
      case 'completed':
        return 'border-color: #4caf50; background: #e8f5e8; color: #388e3c;';
      case 'failed':
        return 'border-color: #f44336; background: #ffebee; color: #d32f2f;';
      case 'cancelled':
        return 'border-color: #9e9e9e; background: #f5f5f5; color: #616161;';
      default:
        return 'border-color: #ddd; background: #f9f9f9; color: #666;';
    }
  }

  /**
   * Get status icon
   */
  private getStatusIcon(status: string): string {
    switch (status) {
      case 'pending': return '⏳';
      case 'processing': return '⚡';
      case 'completed': return '✅';
      case 'failed': return '❌';
      case 'cancelled': return '⏹️';
      default: return 'ℹ️';
    }
  }

  /**
   * Get status text
   */
  private getStatusText(payment: PaymentStatus): string {
    switch (payment.status) {
      case 'pending':
        return 'Preparing payment...';
      case 'processing':
        return payment.retryCount > 0 
          ? `Retrying payment (${payment.retryCount}/${payment.maxRetries})...`
          : 'Processing payment...';
      case 'completed':
        return 'Payment completed successfully';
      case 'failed':
        return payment.retryCount >= payment.maxRetries 
          ? 'Payment failed (max retries exceeded)'
          : 'Payment failed';
      case 'cancelled':
        return 'Payment cancelled';
      default:
        return `Status: ${payment.status}`;
    }
  }

  /**
   * Get progress percentage for progress bar
   */
  private getProgressPercentage(payment: PaymentStatus): number {
    switch (payment.status) {
      case 'pending': return 25;
      case 'processing': return 75;
      case 'completed': return 100;
      case 'failed': return 0;
      case 'cancelled': return 0;
      default: return 0;
    }
  }

  /**
   * Update progress bar
   */
  private updateProgressBar(progressBar: HTMLElement, payment: PaymentStatus): void {
    const fill = progressBar.querySelector('.progress-fill') as HTMLElement;
    if (fill) {
      fill.style.width = `${this.getProgressPercentage(payment)}%`;
    }
  }

  /**
   * Update action buttons
   */
  private updateActionButtons(actionButtons: HTMLElement, payment: PaymentStatus): void {
    const retryBtn = actionButtons.querySelector('.retry-btn') as HTMLButtonElement;
    if (retryBtn) {
      const retriesLeft = payment.maxRetries - payment.retryCount;
      retryBtn.textContent = `Retry (${retriesLeft} left)`;
      retryBtn.disabled = retriesLeft <= 0;
    }
  }

  /**
   * Get notification type color
   */
  private getTypeColor(type: string): string {
    switch (type) {
      case 'success': return '#4caf50';
      case 'error': return '#f44336';
      case 'warning': return '#ff9800';
      case 'info': return '#2196f3';
      default: return '#666';
    }
  }

  /**
   * Get notification type icon
   */
  private getTypeIcon(type: string): string {
    switch (type) {
      case 'success': return '✅';
      case 'error': return '❌';
      case 'warning': return '⚠️';
      case 'info': return 'ℹ️';
      default: return 'ℹ️';
    }
  }

  /**
   * Get default duration for notification type
   */
  private getDefaultDuration(type: string): number {
    switch (type) {
      case 'success': return PaymentStatusTracker.SUCCESS_DURATION;
      case 'error': return PaymentStatusTracker.ERROR_DURATION;
      default: return PaymentStatusTracker.NOTIFICATION_DURATION;
    }
  }

  /**
   * Retry payment (placeholder - would integrate with payment processor)
   */
  private retryPayment(paymentId: string): void {
    console.log(`Retrying payment ${paymentId}`);
    // This would integrate with the PaymentProcessor.retryPayment method
  }

  /**
   * Cancel payment (placeholder - would integrate with payment processor)
   */
  private cancelPayment(paymentId: string): void {
    console.log(`Cancelling payment ${paymentId}`);
    // This would integrate with the PaymentProcessor.cancelPayment method
  }

  /**
   * Clear all notifications
   */
  clearAllNotifications(): void {
    this.notifications.clear();
    document.querySelectorAll('.lightning-toast-notification').forEach(toast => {
      this.removeToast(toast as HTMLElement);
    });
  }

  /**
   * Clear all status displays
   */
  clearAllStatusDisplays(): void {
    this.statusElements.forEach((element, id) => {
      this.removeStatusDisplay(id);
    });
  }

  /**
   * Subscribe to payment status updates (placeholder for integration)
   */
  onPaymentStatusChange(paymentId: string, callback: (status: any) => void): void {
    // This is a placeholder method for the integration example
    // In a real implementation, this would integrate with the payment processor
    console.log(`Subscribing to payment status updates for ${paymentId}`);
  }
}

// Export singleton instance
export const paymentStatusTracker = new PaymentStatusTracker();
