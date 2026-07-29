import prisma from '../config/database';
import logger from '../config/logger';
import { AuditAction } from '@prisma/client';

/**
 * Writes a structured audit log entry. Non-blocking by design: a failure
 * here must never interrupt the caller's primary operation (e.g. a user
 * status update should still succeed even if the audit write fails), so
 * errors are logged rather than thrown. Mirrors the pattern already used
 * in OrganizationService.writeAudit, extracted here so it can be shared
 * across services/controllers instead of being duplicated per file.
 */
export async function writeAuditLog(
  action: AuditAction,
  entityType: string,
  entityId: string,
  actorId?: string,
  changes?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { userId: actorId, action, entityType, entityId, changes },
    });
  } catch (error) {
    logger.error(`Failed to write audit log for ${entityType}:${entityId}`, error);
  }
}
