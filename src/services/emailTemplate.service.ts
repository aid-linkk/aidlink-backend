import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';
import { convert } from 'html-to-text';
import { registerHelpers } from '../templates/emails/helpers';
import prisma from '../config/database';
import logger from '../config/logger';
import { config } from '../config';

export class EmailTemplateService {
  /** Template version map — bump when a template file changes */
  static readonly TEMPLATE_VERSIONS: Record<string, string> = {
    'donation-received': '1.0.0',
    'campaign-update': '1.0.0',
    'distribution-sent': '1.0.0',
    'kyc-approval': '1.0.0',
    'kyc-rejection': '1.0.0',
    'security-alert': '1.0.0',
    receipt: '1.0.0',
    generic: '1.0.0',
  };

  /** Template name used when a specific template fails or is not found */
  static readonly DEFAULT_TEMPLATE = 'generic';

  /** Cache of compiled Handlebars templates (name → compiled delegate) */
  private static compiledTemplates = new Map<string, Handlebars.TemplateDelegate>();

  /** The compiled outer layout template */
  private static compiledLayout: Handlebars.TemplateDelegate | null = null;

  /** Whether initialize() has been called successfully */
  private static initialized = false;

  /** Counter for fallback renders (useful for monitoring) */
  static fallbackCount = 0;

  // ── Initialization ────────────────────────────────────────────────

  /**
   * Load, compile, and cache all templates, partials, and helpers.
   * Must be called once at app startup before any render calls.
   */
  static initialize(): void {
    if (this.initialized) return;

    try {
      // Register Handlebars helpers (formatCurrency, formatDate, etc.)
      registerHelpers();

      // Register partials from disk
      this.registerPartials();

      // Compile the outer layout
      this.compiledLayout = this.compileFile('layouts/main.hbs');

      // Pre-compile all templates
      const templateNames = Object.keys(this.TEMPLATE_VERSIONS);
      for (const name of templateNames) {
        try {
          const tpl = this.compileFile(`${name}.hbs`);
          this.compiledTemplates.set(name, tpl);
        } catch (err) {
          logger.error(`Failed to compile template "${name}":`, err);
        }
      }

      this.initialized = true;
      logger.info(
        `EmailTemplateService initialized — ${this.compiledTemplates.size} templates, ${templateNames.length} registered`
      );
    } catch (err) {
      logger.error('EmailTemplateService initialization failed:', err);
      throw err;
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /**
   * Render an email template to HTML + plain text.
   *
   * @param templateName - Key matching a name in TEMPLATE_VERSIONS
   * @param context       - Data payload injected into the template
   * @returns Rendered HTML and plain-text strings
   */
  static render(
    templateName: string,
    context: Record<string, unknown>
  ): { html: string; text: string } {
    const html = this.renderHtml(templateName, context);
    const text = this.renderText(html);
    return { html, text };
  }

  /**
   * Render only the HTML portion of a template (with layout wrapping).
   * Falls back to the generic template on any error.
   */
  static renderHtml(templateName: string, context: Record<string, unknown>): string {
    if (!this.initialized) {
      this.initialize();
    }

    const tpl = this.compiledTemplates.get(templateName);

    if (!tpl) {
      logger.warn(
        `Template "${templateName}" not found, falling back to "${this.DEFAULT_TEMPLATE}"`
      );
      return this.renderFallback(context, `Template "${templateName}" not found`);
    }

    try {
      // Render the inner content
      const bodyHtml = tpl({
        ...context,
        logoUrl: context.logoUrl || config.email.logoUrl,
        supportEmail: context.supportEmail || config.email.supportEmail,
        currentYear: new Date().getFullYear(),
      });

      // Wrap in the outer layout
      if (this.compiledLayout) {
        return this.compiledLayout({
          subject: context.subject || 'AidLink Notification',
          body: bodyHtml,
          logoUrl: context.logoUrl || config.email.logoUrl,
          supportEmail: context.supportEmail || config.email.supportEmail,
          currentYear: new Date().getFullYear(),
          managePreferencesLink: context.managePreferencesLink || null,
        });
      }

      // No layout available — return body as-is
      return bodyHtml;
    } catch (err) {
      logger.error(`Failed to render template "${templateName}":`, err);
      return this.renderFallback(context, `Template render error: ${(err as Error).message}`);
    }
  }

  /**
   * Convert HTML to plain text for email clients that prefer it.
   */
  static renderText(html: string): string {
    try {
      return convert(html, {
        wordwrap: 80,
        preserveNewlines: true,
        selectors: [
          { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
          { selector: 'img', format: 'skip' },
        ],
      });
    } catch {
      // Ultra-simple fallback: strip all tags
      return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }
  }

  // ── Versioning ────────────────────────────────────────────────────

  /** Get the current version string for a template. */
  static getVersion(templateName: string): string {
    return this.TEMPLATE_VERSIONS[templateName] || '0.0.0';
  }

  /**
   * Write an audit record for every template render.
   * Non-blocking — errors are logged but never thrown.
   */
  static async logRender(
    templateName: string,
    notificationId?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await prisma.emailTemplate.create({
        data: {
          name: templateName,
          version: this.getVersion(templateName),
          notificationId: notificationId || null,
          description: `Rendered for notification${notificationId ? ` ${notificationId}` : ''}`,
          metadata: metadata ? (metadata as object) : undefined,
        },
      });
    } catch (err) {
      logger.error('Failed to log template render:', err);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** Fall back to the generic template with error context. */
  private static renderFallback(
    context: Record<string, unknown>,
    errorNotice: string
  ): string {
    this.fallbackCount++;
    const fallbackTpl = this.compiledTemplates.get(this.DEFAULT_TEMPLATE);

    const fallbackContext = {
      ...context,
      title: context.title || context.subject || 'AidLink Notification',
      message: context.message || 'Please see the details below.',
      errorNotice,
    };

    if (fallbackTpl && this.compiledLayout) {
      try {
        const bodyHtml = fallbackTpl(fallbackContext);
        return this.compiledLayout({
          subject: fallbackContext.title,
          body: bodyHtml,
          logoUrl: config.email.logoUrl,
          supportEmail: config.email.supportEmail,
          currentYear: new Date().getFullYear(),
          managePreferencesLink: null,
        });
      } catch {
        // Ultimate fallback — raw string
      }
    }

    // Last resort: plain HTML string
    return `<html><body><h2>${fallbackContext.title}</h2><p>${fallbackContext.message}</p></body></html>`;
  }

  /** Read and compile a single .hbs file relative to the emails directory. */
  private static compileFile(relativePath: string): Handlebars.TemplateDelegate {
    const templateDir = path.resolve(process.cwd(), 'src/templates/emails');
    const fullPath = path.join(templateDir, relativePath);
    const source = fs.readFileSync(fullPath, 'utf-8');
    return Handlebars.compile(source);
  }

  /** Load and register all partials from src/emails/partials/. */
  private static registerPartials(): void {
    const partialsDir = path.resolve(process.cwd(), 'src/templates/emails/partials');
    if (!fs.existsSync(partialsDir)) {
      logger.warn(`Partials directory not found: ${partialsDir}`);
      return;
    }

    const files = fs.readdirSync(partialsDir).filter((f) => f.endsWith('.hbs'));
    for (const file of files) {
      const name = path.basename(file, '.hbs'); // e.g. "header", "footer"
      const source = fs.readFileSync(path.join(partialsDir, file), 'utf-8');
      Handlebars.registerPartial(name, source);
      logger.debug(`Registered partial: ${name}`);
    }

    logger.info(`Registered ${files.length} email partials`);
  }
}
