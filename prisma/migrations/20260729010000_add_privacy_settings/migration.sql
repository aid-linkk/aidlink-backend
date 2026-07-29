-- Enum for profile visibility (issue #13: user dashboard endpoints)
CREATE TYPE "ProfileVisibility" AS ENUM ('PUBLIC', 'DONORS_ONLY', 'PRIVATE');

-- Per-user privacy settings table
CREATE TABLE "PrivacySettings" (
    "id"                       TEXT NOT NULL,
    "userId"                   TEXT NOT NULL,
    "profileVisibility"        "ProfileVisibility" NOT NULL DEFAULT 'PRIVATE',
    "showDonationHistory"      BOOLEAN NOT NULL DEFAULT false,
    "showRealName"             BOOLEAN NOT NULL DEFAULT false,
    "defaultDonationAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacySettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PrivacySettings_userId_key" ON "PrivacySettings"("userId");
CREATE INDEX "PrivacySettings_userId_idx" ON "PrivacySettings"("userId");

ALTER TABLE "PrivacySettings" ADD CONSTRAINT "PrivacySettings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
