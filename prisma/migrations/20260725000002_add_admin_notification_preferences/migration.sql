-- Enums for admin notification preferences
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'IN_APP', 'SMS');
CREATE TYPE "NotificationFrequency" AS ENUM ('IMMEDIATE', 'DAILY_DIGEST', 'WEEKLY');
CREATE TYPE "AdminNotificationTypePreference" AS ENUM ('ALL', 'ALERTS_ONLY', 'NONE');

-- Admin notification preferences table
CREATE TABLE "AdminNotificationPreference" (
    "id"               TEXT NOT NULL,
    "userId"           TEXT NOT NULL,
    -- JSON: Record<NotificationType, AdminNotificationTypePreference>
    "typePreferences"  JSONB NOT NULL DEFAULT '{}',
    -- Array of enabled channels
    "channels"         "NotificationChannel"[] NOT NULL DEFAULT ARRAY['EMAIL', 'IN_APP']::"NotificationChannel"[],
    -- Delivery frequency
    "frequency"        "NotificationFrequency" NOT NULL DEFAULT 'IMMEDIATE',
    -- Entity filters: optional arrays of campaign IDs / user role strings to restrict events to
    "campaignFilter"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "userRoleFilter"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Global mute (overrides everything except SECURITY_ALERT)
    "muteAll"          BOOLEAN NOT NULL DEFAULT false,
    -- Quiet hours (UTC): e.g. "22:00-07:00" — no immediate delivery in this window
    "quietHoursStart"  TEXT,
    "quietHoursEnd"    TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminNotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminNotificationPreference_userId_key" ON "AdminNotificationPreference"("userId");
CREATE INDEX "AdminNotificationPreference_userId_idx"  ON "AdminNotificationPreference"("userId");

-- Digest queue table — holds notifications pending batched delivery
CREATE TABLE "NotificationDigestQueue" (
    "id"                TEXT NOT NULL,
    "userId"            TEXT NOT NULL,
    "notificationId"    TEXT NOT NULL,
    "frequency"         "NotificationFrequency" NOT NULL,
    "scheduledFor"      TIMESTAMP(3) NOT NULL,
    "sent"              BOOLEAN NOT NULL DEFAULT false,
    "sentAt"            TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDigestQueue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationDigestQueue_userId_sent_idx"       ON "NotificationDigestQueue"("userId", "sent");
CREATE INDEX "NotificationDigestQueue_scheduledFor_sent_idx" ON "NotificationDigestQueue"("scheduledFor", "sent");
