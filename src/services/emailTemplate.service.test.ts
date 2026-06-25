import { EmailTemplateService } from './emailTemplate.service';

// Mock fs to provide template content without real files
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(true),
    readdirSync: jest.fn().mockReturnValue(['header.hbs', 'footer.hbs', 'button.hbs', 'greeting.hbs']),
    readFileSync: jest.fn((filePath: string) => {
      const filename = filePath.replace(/\\/g, '/');

      // Layout
      if (filename.includes('layouts/main')) {
        return `
          <!DOCTYPE html><html><body>
            {{> header}}
            {{{body}}}
            {{> footer}}
          </body></html>`;
      }

      // Partials
      if (filename.includes('partials/header')) {
        return '<div style="background:#1f7a5a;"><img src="{{logoUrl}}" alt="AidLink" /></div>';
      }
      if (filename.includes('partials/footer')) {
        return '<div style="border-top:1px solid #e0e0e0;">&copy; {{currentYear}} AidLink | {{supportEmail}}</div>';
      }
      if (filename.includes('partials/button')) {
        return '<a href="{{link}}" style="background:#1f7a5a;">{{label}}</a>';
      }
      if (filename.includes('partials/greeting')) {
        return '<p>Hello {{defaultName name fallback}},</p>';
      }

      // Templates
      if (filename.includes('donation-received')) {
        return `
          {{> greeting name=donorName fallback="Supporter"}}
          <h1>Thank you!</h1>
          <p>Amount: {{formatCurrency amount currency}}</p>
          <p>Campaign: {{campaignName}}</p>
          <p>Date: {{formatDate date}}</p>
          {{#if receiptLink}}
            {{> button link=receiptLink label="Download Receipt"}}
          {{/if}}
          {{#if impactSummary}}<p>{{impactSummary}}</p>{{/if}}
        `;
      }
      if (filename.includes('kyc-approval')) {
        return `
          {{> greeting name=userName fallback="there"}}
          <h1>KYC Approved</h1>
          {{#if welcomeMessage}}<p>{{welcomeMessage}}</p>{{/if}}
          {{#if nextSteps}}<p>{{nextSteps}}</p>{{/if}}
        `;
      }
      if (filename.includes('kyc-rejection')) {
        return `
          {{> greeting name=userName fallback="there"}}
          <h1>KYC Rejected</h1>
          {{#if rejectionReason}}<p>{{rejectionReason}}</p>{{/if}}
          {{#if correctionSteps}}<p>{{correctionSteps}}</p>{{/if}}
          {{#if resubmitLink}}
            {{> button link=resubmitLink label="Resubmit"}}
          {{/if}}
        `;
      }
      if (filename.includes('security-alert')) {
        return `
          {{> greeting name=userName fallback="there"}}
          <h1>Security Alert</h1>
          <p>{{whatHappened}}</p>
          {{#ifEq alertType "suspicious_login"}}<p>Suspicious Login</p>{{/ifEq}}
          {{#if recommendedActions}}<p>{{recommendedActions}}</p>{{/if}}
          {{#if ipAddress}}<p>IP: {{ipAddress}}</p>{{/if}}
        `;
      }
      if (filename.includes('generic')) {
        return `
          {{> greeting name=userName fallback="there"}}
          {{#if title}}<h1>{{title}}</h1>{{/if}}
          <p>{{message}}</p>
          {{#if actionLink}}
            {{> button link=actionLink label=(defaultName actionLabel "View Details")}}
          {{/if}}
        `;
      }
      if (filename.includes('receipt')) {
        return `
          {{> greeting name=donorName fallback="Supporter"}}
          <h1>Receipt {{receiptNumber}}</h1>
          <p>{{organizationName}} | {{formatCurrency amount currency}}</p>
        `;
      }
      if (filename.includes('campaign-update')) {
        return `
          {{> greeting name=userName fallback="Supporter"}}
          <h1>{{campaignTitle}}</h1>
          <p>{{updateSummary}}</p>
        `;
      }
      if (filename.includes('distribution-sent')) {
        return `
          {{> greeting name=userName fallback="Beneficiary"}}
          <h1>Distribution Sent</h1>
          <p>{{formatCurrency amount currency}}</p>
        `;
      }

      return '';
    }),
  };
});

// Mock prisma
jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    emailTemplate: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
  },
}));

jest.mock('../config', () => ({
  config: {
    email: {
      logoUrl: 'https://aidlink.org/logo.png',
      supportEmail: 'support@aidlink.org',
      appUrl: 'http://localhost:3000',
    },
  },
}));

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

describe('EmailTemplateService', () => {
  beforeAll(() => {
    EmailTemplateService.initialize();
  });

  describe('initialize', () => {
    it('compiles all registered templates', () => {
      expect(EmailTemplateService['initialized']).toBe(true);
      expect(EmailTemplateService['compiledTemplates'].size).toBeGreaterThan(0);
    });

    it('is idempotent', () => {
      EmailTemplateService.initialize(); // second call should be a no-op
      expect(EmailTemplateService['initialized']).toBe(true);
    });
  });

  describe('getVersion', () => {
    it('returns version for known templates', () => {
      expect(EmailTemplateService.getVersion('donation-received')).toBe('1.0.0');
      expect(EmailTemplateService.getVersion('kyc-approval')).toBe('1.0.0');
    });

    it('returns fallback version for unknown templates', () => {
      expect(EmailTemplateService.getVersion('nonexistent')).toBe('0.0.0');
    });
  });

  describe('render', () => {
    it('renders donation-received template with full context', () => {
      const { html, text } = EmailTemplateService.render('donation-received', {
        donorName: 'Alice',
        campaignName: 'Emergency Relief',
        amount: 100,
        currency: 'XLM',
        date: '2026-06-15T00:00:00Z',
        impactSummary: 'Helping 50 families',
        receiptLink: 'https://aidlink.org/receipts/1',
      });

      expect(html).toContain('Alice');
      expect(html).toContain('Emergency Relief');
      expect(html).toContain('100.00 XLM');
      expect(html).toContain('June 15, 2026');
      expect(html).toContain('Download Receipt');
      expect(html).toContain('Helping 50 families');

      // Plain text fallback
      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
    });

    it('renders donation-received without optional fields', () => {
      const { html } = EmailTemplateService.render('donation-received', {
        campaignName: 'Test Campaign',
        amount: 50,
        currency: 'XLM',
        date: '2026-06-15T00:00:00Z',
      });

      expect(html).toContain('Test Campaign');
      // No receipt link section should be rendered
      expect(html).not.toContain('Download Receipt');
    });

    it('renders kyc-approval with welcome message', () => {
      const { html } = EmailTemplateService.render('kyc-approval', {
        userName: 'Bob',
        approvedDate: '2026-06-20T00:00:00Z',
        welcomeMessage: 'Welcome aboard!',
        nextSteps: 'Start receiving distributions.',
      });

      expect(html).toContain('Bob');
      expect(html).toContain('Welcome aboard!');
      expect(html).toContain('Start receiving distributions');
    });

    it('renders kyc-rejection with resubmit link', () => {
      const { html } = EmailTemplateService.render('kyc-rejection', {
        userName: 'Charlie',
        rejectionReason: 'Document unclear',
        correctionSteps: 'Upload a clearer photo.',
        resubmitLink: 'https://aidlink.org/kyc/resubmit',
      });

      expect(html).toContain('Document unclear');
      expect(html).toContain('Upload a clearer photo');
      expect(html).toContain('Resubmit');
      expect(html).toContain('https://aidlink.org/kyc/resubmit');
    });

    it('renders security-alert with suspicious_login alert type', () => {
      const { html } = EmailTemplateService.render('security-alert', {
        userName: 'Dave',
        alertType: 'suspicious_login',
        whatHappened: 'Login from unknown device',
        ipAddress: '192.168.1.100',
        recommendedActions: 'Change your password immediately.',
        timestamp: '2026-06-22T10:30:00Z',
      });

      expect(html).toContain('Login from unknown device');
      expect(html).toContain('Suspicious Login');
      expect(html).toContain('192.168.1.100');
      expect(html).toContain('Change your password');
    });

    it('renders generic template with action link', () => {
      const { html } = EmailTemplateService.render('generic', {
        title: 'System Update',
        message: 'Scheduled maintenance tonight.',
        actionLink: 'https://aidlink.org/status',
        actionLabel: 'Check Status',
      });

      expect(html).toContain('System Update');
      expect(html).toContain('Scheduled maintenance');
      expect(html).toContain('Check Status');
    });
  });

  describe('render fallback behavior', () => {
    it('falls back to generic when requested template is not compiled', () => {
      const { html } = EmailTemplateService.render('nonexistent-template', {
        title: 'Fallback Title',
        message: 'Fallback message content.',
      });

      // Should render via generic template
      expect(html).toContain('Fallback Title');
      expect(html).toContain('Fallback message content');
      expect(EmailTemplateService.fallbackCount).toBeGreaterThan(0);
    });
  });

  describe('renderText', () => {
    it('strips HTML tags for plain-text output', () => {
      const text = EmailTemplateService.renderText(
        '<html><body><p>Hello World</p><p>This is a test.</p></body></html>'
      );

      expect(text).toContain('Hello World');
      expect(text).toContain('This is a test.');
      expect(text).not.toContain('<p>');
    });
  });

  describe('logRender', () => {
    it('writes an audit record', async () => {
      const prisma = require('../config/database').default;
      await EmailTemplateService.logRender('donation-received', 'notif-1', { key: 'value' });

      expect(prisma.emailTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'donation-received',
            version: '1.0.0',
            notificationId: 'notif-1',
          }),
        })
      );
    });
  });

  describe('helpers', () => {
    it('formatCurrency formats numbers correctly', () => {
      const { html } = EmailTemplateService.render('donation-received', {
        amount: 1234.5,
        currency: 'XLM',
        campaignName: 'Test',
        date: '2026-01-01T00:00:00Z',
      });

      expect(html).toContain('1,234.50 XLM');
    });

    it('formatDate formats dates correctly', () => {
      const { html } = EmailTemplateService.render('donation-received', {
        amount: 100,
        currency: 'XLM',
        campaignName: 'Test',
        date: '2026-03-15T00:00:00Z',
      });

      expect(html).toContain('March 15, 2026');
    });

    it('defaultName uses fallback when name is missing', () => {
      const { html } = EmailTemplateService.render('donation-received', {
        amount: 100,
        currency: 'XLM',
        campaignName: 'Test',
        date: '2026-01-01T00:00:00Z',
      });

      // Should greet with "Supporter" as fallback
      expect(html).toContain('Hello Supporter');
    });
  });
});
