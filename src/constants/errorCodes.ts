/**
 * Canonical error code taxonomy for the API.
 *
 * Every domain-specific error thrown by a service should carry one of these
 * codes so that clients can branch on a stable identifier instead of parsing
 * human-readable messages. See docs/ERROR_CODES.md for the rendered catalog
 * (kept in sync with this file — update both together).
 *
 * Naming convention: `<DOMAIN>_<3-digit sequence>`. Codes are grouped by the
 * resource/domain they describe, not by which service file throws them —
 * several services intentionally reuse the same code (e.g. any lookup that
 * fails to find a campaign uses CAMPAIGN_002, regardless of which endpoint
 * triggered it) so the taxonomy stays small and consistent.
 */
export interface ErrorCodeDefinition {
  /** Default HTTP status code for this error. */
  httpStatus: number;
  /** Default human-readable message; call sites may override with a more specific message. */
  message: string;
  /** Why this error occurs. */
  cause: string;
  /** What the client (or caller) should do about it. */
  solution: string;
}

export const ErrorCodes = {
  // ── COMMON — cross-cutting authorization ──────────────────────────
  COMMON_001: {
    httpStatus: 403,
    message: 'You do not have permission to perform this action',
    cause: 'The authenticated user is neither the owner of the resource nor holds a role ' +
      '(ADMIN/VERIFIER, as applicable) that is authorized to act on it.',
    solution: 'Retry the request as the resource owner, or use an account with the required role.',
  },

  // ── AUTH ────────────────────────────────────────────────────────────
  AUTH_001: {
    httpStatus: 409,
    message: 'An account with these credentials already exists',
    cause: 'Registration was attempted with an email or username that is already taken.',
    solution: 'Sign in instead, use the password-reset flow, or choose a different email/username.',
  },
  AUTH_002: {
    httpStatus: 401,
    message: 'Invalid credentials',
    cause: 'The email/password combination does not match any active account.',
    solution: 'Double-check the email and password. Use the password-reset flow if the password was forgotten.',
  },
  AUTH_003: {
    httpStatus: 403,
    message: 'This account is restricted',
    cause: 'The account has been suspended or soft-deleted by an administrator or the moderation system.',
    solution: 'Contact support to review the account status; the login cannot proceed until it is resolved.',
  },
  AUTH_004: {
    httpStatus: 403,
    message: 'Please verify your email before logging in',
    cause: 'The account exists and the password is correct, but the email address has not been verified yet.',
    solution: 'Check the inbox for the verification email, or call the resend-verification endpoint.',
  },
  AUTH_005: {
    httpStatus: 400,
    message: 'Verification link expired or invalid',
    cause: 'The verification token on the link does not match a pending record, or it was already consumed.',
    solution: 'Request a new verification email; the previous link can no longer be used.',
  },
  AUTH_006: {
    httpStatus: 429,
    message: 'Too many verification attempts. Please try again later',
    cause: 'The account exceeded the allowed number of failed verification attempts or resend requests ' +
      'in the current window.',
    solution: 'Wait for the cooldown window to pass before requesting or submitting another verification attempt.',
  },
  AUTH_007: {
    httpStatus: 401,
    message: 'Invalid refresh token',
    cause: 'The refresh token is not recognized, or the session it belongs to has expired/been revoked.',
    solution: 'Sign in again to obtain a new access/refresh token pair.',
  },
  AUTH_008: {
    httpStatus: 404,
    message: 'User not found',
    cause: 'No user record exists for the given identifier.',
    solution: 'Verify the user ID/session is current; the account may have been deleted.',
  },
  AUTH_009: {
    httpStatus: 400,
    message: 'Invalid or expired verification token',
    cause: 'The email verification token does not exist, has expired, or was already used.',
    solution: 'Request a new verification email and use the newest link only.',
  },
  AUTH_010: {
    httpStatus: 400,
    message: 'Email already verified',
    cause: 'A resend/verify action was requested for an account whose email is already verified.',
    solution: 'No action needed — proceed to log in.',
  },

  // ── CAMPAIGN ────────────────────────────────────────────────────────
  CAMPAIGN_001: {
    httpStatus: 400,
    message: 'Campaign input failed validation',
    cause: 'One or more campaign fields (title, description, targetAmount, dates, imageUrl, milestone or ' +
      'beneficiary-assignment fields) did not meet the required format or constraints.',
    solution: 'Check the `details`/message for the specific field and constraint, then resubmit with a valid value.',
  },
  CAMPAIGN_002: {
    httpStatus: 404,
    message: 'Campaign not found',
    cause: 'No campaign exists for the given ID, or it was deleted.',
    solution: 'Verify the campaign ID. It may need to be re-fetched from a campaign listing.',
  },
  CAMPAIGN_003: {
    httpStatus: 400,
    message: 'Campaign is not in a valid state for this operation',
    cause: 'The campaign\'s current status does not allow the requested action — e.g. it is completed, ' +
      'cancelled, suspended, or a status transition was requested that must go through moderation.',
    solution: 'Check the campaign\'s current status; suspended campaigns must be reinstated via the ' +
      'moderation/appeal workflow, and completed/cancelled campaigns cannot be modified.',
  },

  // ── ORGANIZATION ────────────────────────────────────────────────────
  ORG_001: {
    httpStatus: 404,
    message: 'Organization not found',
    cause: 'No organization exists for the given ID (or it was soft-deleted).',
    solution: 'Verify the organization ID belongs to an active organization.',
  },
  ORG_002: {
    httpStatus: 409,
    message: 'User already has an organization profile',
    cause: 'Each user may register at most one organization profile.',
    solution: 'Use the existing organization profile instead of creating a new one.',
  },
  ORG_003: {
    httpStatus: 404,
    message: 'Bank account not found',
    cause: 'No bank account record exists for the given ID under this organization.',
    solution: 'Verify the bank account ID, or add the bank account first.',
  },

  // ── DONATION ────────────────────────────────────────────────────────
  DONATION_001: {
    httpStatus: 404,
    message: 'Donation not found',
    cause: 'No donation exists for the given ID.',
    solution: 'Verify the donation ID.',
  },
  DONATION_002: {
    httpStatus: 400,
    message: 'Donation already confirmed',
    cause: 'The donation has already transitioned to CONFIRMED and cannot be confirmed again.',
    solution: 'No action needed; re-fetch the donation to see its current state.',
  },
  DONATION_003: {
    httpStatus: 400,
    message: 'Donation identity has already been revealed',
    cause: 'A request to reveal the donor identity was made for a donation that is already identified.',
    solution: 'Fetch the donation to read the already-revealed identity instead of re-requesting it.',
  },
  DONATION_004: {
    httpStatus: 400,
    message: 'Donation cannot be refunded',
    cause: 'Either the donation is not CONFIRMED (only confirmed donations can be refunded), or the ' +
      'requested refund amount exceeds the campaign\'s current balance.',
    solution: 'Confirm the donation status and request a refund amount at or below the campaign\'s current balance.',
  },

  // ── BENEFICIARY ─────────────────────────────────────────────────────
  BENEFICIARY_001: {
    httpStatus: 404,
    message: 'Beneficiary not found',
    cause: 'No beneficiary (or beneficiary profile) exists for the given ID.',
    solution: 'Verify the beneficiary ID.',
  },
  BENEFICIARY_002: {
    httpStatus: 400,
    message: 'Beneficiary profile already exists for this user',
    cause: 'Each user may register at most one beneficiary profile.',
    solution: 'Use the existing beneficiary profile instead of creating a new one.',
  },
  BENEFICIARY_003: {
    httpStatus: 409,
    message: 'An active KYC submission already exists',
    cause: 'The beneficiary already has a KYC submission in PENDING or UNDER_REVIEW status.',
    solution: 'Wait for the current KYC review to complete before submitting a new one.',
  },
  BENEFICIARY_004: {
    httpStatus: 404,
    message: 'KYC submission not found',
    cause: 'No KYC submission exists for the given ID.',
    solution: 'Verify the KYC submission ID.',
  },

  // ── DISTRIBUTION ────────────────────────────────────────────────────
  DISTRIBUTION_001: {
    httpStatus: 404,
    message: 'Distribution not found',
    cause: 'No distribution exists for the given ID.',
    solution: 'Verify the distribution ID.',
  },
  DISTRIBUTION_002: {
    httpStatus: 400,
    message: 'Distribution is not in a valid state for this operation',
    cause: 'Either the distribution is already COMPLETED, or the target beneficiary is not assigned ' +
      'to the campaign the distribution is for.',
    solution: 'Assign the beneficiary to the campaign first, or check the distribution\'s current status.',
  },

  // ── MILESTONE ───────────────────────────────────────────────────────
  MILESTONE_001: {
    httpStatus: 404,
    message: 'Milestone not found',
    cause: 'No milestone exists for the given ID under the specified campaign.',
    solution: 'Verify the milestone ID and that it belongs to the campaign referenced in the request.',
  },
  MILESTONE_002: {
    httpStatus: 404,
    message: 'Submission not found',
    cause: 'No milestone submission exists for the given ID.',
    solution: 'Verify the submission ID.',
  },
  MILESTONE_003: {
    httpStatus: 409,
    message: 'An active submission already exists for this milestone',
    cause: 'A submission for this milestone is already SUBMITTED, UNDER_REVIEW, or APPROVED.',
    solution: 'Wait for the active submission to be resolved, or edit it instead of creating a new one.',
  },
  MILESTONE_004: {
    httpStatus: 400,
    message: 'Submission is not in a valid state for this operation',
    cause: 'The submission\'s current status does not allow editing, submitting for review, or reviewing ' +
      '(e.g. it was already approved/rejected).',
    solution: 'Check the submission\'s current status before retrying; only DRAFT/REVISION_REQUESTED ' +
      'submissions can be edited or resubmitted, and only SUBMITTED/UNDER_REVIEW ones can be reviewed.',
  },

  // ── MULTIPLIER ──────────────────────────────────────────────────────
  MULTIPLIER_001: {
    httpStatus: 404,
    message: 'Multiplier not found',
    cause: 'No donation multiplier exists for the given ID under this campaign.',
    solution: 'Verify the multiplier ID and campaign.',
  },
  MULTIPLIER_002: {
    httpStatus: 400,
    message: 'Multiplier input failed validation',
    cause: 'One or more multiplier fields (multiplier factor, matchCap, perDonationCap, startAt/endAt, ' +
      'milestoneId) did not meet the required format or constraints.',
    solution: 'Check the message for the specific field and constraint, then resubmit with a valid value.',
  },
  MULTIPLIER_003: {
    httpStatus: 400,
    message: 'Multiplier update conflicts with existing matched-fund allocations',
    cause: 'The requested matchCap is lower than the amount already matched under this multiplier.',
    solution: 'Choose a matchCap greater than or equal to the amount already matched.',
  },

  // ── MODERATION ──────────────────────────────────────────────────────
  MODERATION_001: {
    httpStatus: 404,
    message: 'Appeal not found',
    cause: 'No appeal exists for the given ID.',
    solution: 'Verify the appeal ID.',
  },
  MODERATION_002: {
    httpStatus: 400,
    message: 'Appeal is not in a valid state for this operation',
    cause: 'The appeal was already resolved, the campaign is not suspended, or there is no active ' +
      'suspension to appeal.',
    solution: 'Re-fetch the campaign/appeal to confirm its current moderation status before retrying.',
  },
  MODERATION_003: {
    httpStatus: 409,
    message: 'An appeal is already in progress for this suspension',
    cause: 'Only one open appeal is allowed per suspension.',
    solution: 'Wait for the existing appeal to be resolved before submitting another.',
  },
  MODERATION_004: {
    httpStatus: 400,
    message: 'Appeal message must be at least 10 characters long',
    cause: 'The submitted appeal message is too short to be reviewed meaningfully.',
    solution: 'Provide a longer explanation (at least 10 characters) and resubmit.',
  },

  // ── RECOVERY ────────────────────────────────────────────────────────
  RECOVERY_001: {
    httpStatus: 404,
    message: 'Recovery case not found',
    cause: 'No recovery case exists for the given ID.',
    solution: 'Verify the recovery case ID.',
  },
  RECOVERY_002: {
    httpStatus: 400,
    message: 'Recovery case is not of the expected type for this operation',
    cause: 'The recovery case exists but its `type` (e.g. FAILED_REFUND, FAILED_DISTRIBUTION, ' +
      'CANCELLED_CAMPAIGN_FUNDS) does not match the action being performed.',
    solution: 'Use the endpoint that matches the recovery case\'s actual type.',
  },
  RECOVERY_003: {
    httpStatus: 400,
    message: 'Recovery case has already been resolved',
    cause: 'The recovery case status is already RECOVERED and cannot be actioned again.',
    solution: 'No action needed; re-fetch the case to see its resolution details.',
  },
  RECOVERY_004: {
    httpStatus: 400,
    message: 'Recovery settlement input failed validation',
    cause: 'The recovery case has no linked campaign, no targetCampaignId was supplied for a ' +
      'transfer-to-campaign settlement, or the target campaign does not exist / is not active.',
    solution: 'Supply a valid, active targetCampaignId for transfer settlements, or choose a different ' +
      'settlement option.',
  },

  // ── WEBHOOK ─────────────────────────────────────────────────────────
  WEBHOOK_001: {
    httpStatus: 404,
    message: 'Webhook not found',
    cause: 'No webhook (or webhook event) exists for the given ID.',
    solution: 'Verify the webhook ID.',
  },
  WEBHOOK_002: {
    httpStatus: 400,
    message: 'Webhook URL must use HTTPS',
    cause: 'The provided webhook URL uses an insecure scheme (http:// or non-URL).',
    solution: 'Provide an https:// URL for the webhook endpoint.',
  },

  // ── STORAGE / UPLOADS ───────────────────────────────────────────────
  STORAGE_001: {
    httpStatus: 400,
    message: 'Uploaded file is empty',
    cause: 'The uploaded buffer contained zero bytes.',
    solution: 'Re-select the file and retry the upload.',
  },
  STORAGE_002: {
    httpStatus: 413,
    message: 'File exceeds the maximum allowed size',
    cause: 'The uploaded file is larger than the size limit configured for this upload type.',
    solution: 'Compress or resize the file, or upload a smaller file.',
  },
  STORAGE_003: {
    httpStatus: 415,
    message: 'File type is not supported for this upload',
    cause: 'The file\'s detected MIME type could not be determined, or is not in the allow-list for this upload type.',
    solution: 'Convert the file to one of the supported formats for this upload type and retry.',
  },
  STORAGE_004: {
    httpStatus: 422,
    message: 'File appears to be corrupt or in an unsupported format',
    cause: 'Image processing (metadata read, resize, or transcode) failed on the uploaded file.',
    solution: 'Re-export the image from its source application and retry the upload.',
  },
  STORAGE_005: {
    httpStatus: 422,
    message: 'Image dimensions are below the minimum required',
    cause: 'The uploaded image is smaller than the minimum width/height configured for this upload type.',
    solution: 'Upload a higher-resolution image that meets the minimum dimensions.',
  },

  // ── RECEIPT ─────────────────────────────────────────────────────────
  RECEIPT_001: {
    httpStatus: 400,
    message: 'Receipts can only be generated for confirmed donations',
    cause: 'A receipt was requested for a donation that has not reached CONFIRMED status.',
    solution: 'Wait for the donation to be confirmed before requesting a receipt.',
  },
  RECEIPT_002: {
    httpStatus: 422,
    message: 'Cannot generate a receipt: donation has no associated donor account',
    cause: 'The donation is not linked to a user account with an email address (e.g. a guest donation).',
    solution: 'This donation cannot receive an emailed receipt; generate a receipt record without email delivery instead.',
  },
  RECEIPT_003: {
    httpStatus: 404,
    message: 'Receipt not found',
    cause: 'No tax receipt exists for the given ID.',
    solution: 'Verify the receipt ID.',
  },
  RECEIPT_004: {
    httpStatus: 404,
    message: 'Batch job not found',
    cause: 'No receipt batch job exists for the given ID.',
    solution: 'Verify the batch job ID.',
  },
} as const satisfies Record<string, ErrorCodeDefinition>;

export type ErrorCodeKey = keyof typeof ErrorCodes;
