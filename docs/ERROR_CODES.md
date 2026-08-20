# Error Code Reference

Every error response uses the envelope described in [API.md](API.md#error-response):

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "errorCode": "CAMPAIGN_002",
    "message": "Campaign not found"
  }
}
```

There are two codes on an error, at two different levels of granularity:

| Field | Purpose | Example values |
|---|---|---|
| `code` | Generic HTTP-category code. Cheap to branch on ("is this a 404-shaped error?"). | `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `RATE_LIMITED`, `INTERNAL_SERVER_ERROR` |
| `errorCode` | Stable, domain-specific taxonomy code. Identifies the exact error condition regardless of how the message is worded, so clients/SDKs can switch on it safely across releases. | `AUTH_001`, `CAMPAIGN_002`, `DONATION_004`, ... |

`errorCode` is set whenever a service raises the error via `AppError.from(...)` (see
`src/constants/errorCodes.ts`, the source of truth this document is generated from — update both
together). Framework-level errors that aren't tied to a specific business resource — request-body
validation (`express-validator`), authentication middleware, rate limiting, file-upload plumbing —
only set `code`, since there's no single resource/domain to attribute them to.

`message` is always safe to show to a user; it is not localized and may include call-site-specific
detail (e.g. which field failed validation) that goes beyond the default text shown below.

## Taxonomy

Codes are grouped by the domain/resource they describe, not by which file throws them — several
services intentionally reuse the same code. For example, any lookup that fails to find a campaign
(whether from the campaign, milestone, moderation, multiplier, or recovery service) uses
`CAMPAIGN_002`, so a client only needs to learn the meaning of a code once.

### COMMON — cross-cutting authorization

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `COMMON_001` | 403 | You do not have permission to perform this action | The authenticated user is neither the owner of the resource nor holds a role (ADMIN/VERIFIER, as applicable) that is authorized to act on it. | Retry the request as the resource owner, or use an account with the required role. |

### AUTH

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `AUTH_001` | 409 | An account with these credentials already exists | Registration was attempted with an email or username that is already taken. | Sign in instead, use the password-reset flow, or choose a different email/username. |
| `AUTH_002` | 401 | Invalid credentials | The email/password combination does not match any active account. | Double-check the email and password. Use the password-reset flow if the password was forgotten. |
| `AUTH_003` | 403 | This account is restricted | The account has been suspended or soft-deleted by an administrator or the moderation system. | Contact support to review the account status; the login cannot proceed until it is resolved. |
| `AUTH_004` | 403 | Please verify your email before logging in | The account exists and the password is correct, but the email address has not been verified yet. | Check the inbox for the verification email, or call the resend-verification endpoint. |
| `AUTH_005` | 400 | Verification link expired or invalid | The verification token on the link does not match a pending record, or it was already consumed. | Request a new verification email; the previous link can no longer be used. |
| `AUTH_006` | 429 | Too many verification attempts. Please try again later | The account exceeded the allowed number of failed verification attempts or resend requests in the current window. | Wait for the cooldown window to pass before requesting or submitting another verification attempt. |
| `AUTH_007` | 401 | Invalid refresh token | The refresh token is not recognized, or the session it belongs to has expired/been revoked. | Sign in again to obtain a new access/refresh token pair. |
| `AUTH_008` | 404 | User not found | No user record exists for the given identifier. | Verify the user ID/session is current; the account may have been deleted. |
| `AUTH_009` | 400 | Invalid or expired verification token | The email verification token does not exist, has expired, or was already used. | Request a new verification email and use the newest link only. |
| `AUTH_010` | 400 | Email already verified | A resend/verify action was requested for an account whose email is already verified. | No action needed — proceed to log in. |

### CAMPAIGN

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `CAMPAIGN_001` | 400 | Campaign input failed validation | One or more campaign fields (title, description, targetAmount, dates, imageUrl, milestone or beneficiary-assignment fields) did not meet the required format or constraints. | Check the `details`/message for the specific field and constraint, then resubmit with a valid value. |
| `CAMPAIGN_002` | 404 | Campaign not found | No campaign exists for the given ID, or it was deleted. | Verify the campaign ID. It may need to be re-fetched from a campaign listing. |
| `CAMPAIGN_003` | 400 | Campaign is not in a valid state for this operation | The campaign's current status does not allow the requested action — e.g. it is completed, cancelled, suspended, or a status transition was requested that must go through moderation. | Check the campaign's current status; suspended campaigns must be reinstated via the moderation/appeal workflow, and completed/cancelled campaigns cannot be modified. |

### ORG — organizations

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `ORG_001` | 404 | Organization not found | No organization exists for the given ID (or it was soft-deleted). | Verify the organization ID belongs to an active organization. |
| `ORG_002` | 409 | User already has an organization profile | Each user may register at most one organization profile. | Use the existing organization profile instead of creating a new one. |
| `ORG_003` | 404 | Bank account not found | No bank account record exists for the given ID under this organization. | Verify the bank account ID, or add the bank account first. |

### DONATION

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `DONATION_001` | 404 | Donation not found | No donation exists for the given ID. | Verify the donation ID. |
| `DONATION_002` | 400 | Donation already confirmed | The donation has already transitioned to CONFIRMED and cannot be confirmed again. | No action needed; re-fetch the donation to see its current state. |
| `DONATION_003` | 400 | Donation identity has already been revealed | A request to reveal the donor identity was made for a donation that is already identified. | Fetch the donation to read the already-revealed identity instead of re-requesting it. |
| `DONATION_004` | 400 | Donation cannot be refunded | Either the donation is not CONFIRMED (only confirmed donations can be refunded), or the requested refund amount exceeds the campaign's current balance. | Confirm the donation status and request a refund amount at or below the campaign's current balance. |

### BENEFICIARY

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `BENEFICIARY_001` | 404 | Beneficiary not found | No beneficiary (or beneficiary profile) exists for the given ID. | Verify the beneficiary ID. |
| `BENEFICIARY_002` | 400 | Beneficiary profile already exists for this user | Each user may register at most one beneficiary profile. | Use the existing beneficiary profile instead of creating a new one. |
| `BENEFICIARY_003` | 409 | An active KYC submission already exists | The beneficiary already has a KYC submission in PENDING or UNDER_REVIEW status. | Wait for the current KYC review to complete before submitting a new one. |
| `BENEFICIARY_004` | 404 | KYC submission not found | No KYC submission exists for the given ID. | Verify the KYC submission ID. |

### DISTRIBUTION

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `DISTRIBUTION_001` | 404 | Distribution not found | No distribution exists for the given ID. | Verify the distribution ID. |
| `DISTRIBUTION_002` | 400 | Distribution is not in a valid state for this operation | Either the distribution is already COMPLETED, or the target beneficiary is not assigned to the campaign the distribution is for. | Assign the beneficiary to the campaign first, or check the distribution's current status. |

### MILESTONE

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `MILESTONE_001` | 404 | Milestone not found | No milestone exists for the given ID under the specified campaign. | Verify the milestone ID and that it belongs to the campaign referenced in the request. |
| `MILESTONE_002` | 404 | Submission not found | No milestone submission exists for the given ID. | Verify the submission ID. |
| `MILESTONE_003` | 409 | An active submission already exists for this milestone | A submission for this milestone is already SUBMITTED, UNDER_REVIEW, or APPROVED. | Wait for the active submission to be resolved, or edit it instead of creating a new one. |
| `MILESTONE_004` | 400 | Submission is not in a valid state for this operation | The submission's current status does not allow editing, submitting for review, or reviewing (e.g. it was already approved/rejected). | Check the submission's current status before retrying; only DRAFT/REVISION_REQUESTED submissions can be edited or resubmitted, and only SUBMITTED/UNDER_REVIEW ones can be reviewed. |

### MULTIPLIER — donation multipliers / matched funds

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `MULTIPLIER_001` | 404 | Multiplier not found | No donation multiplier exists for the given ID under this campaign. | Verify the multiplier ID and campaign. |
| `MULTIPLIER_002` | 400 | Multiplier input failed validation | One or more multiplier fields (multiplier factor, matchCap, perDonationCap, startAt/endAt, milestoneId) did not meet the required format or constraints. | Check the message for the specific field and constraint, then resubmit with a valid value. |
| `MULTIPLIER_003` | 400 | Multiplier update conflicts with existing matched-fund allocations | The requested matchCap is lower than the amount already matched under this multiplier. | Choose a matchCap greater than or equal to the amount already matched. |

### MODERATION — suspensions and appeals

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `MODERATION_001` | 404 | Appeal not found | No appeal exists for the given ID. | Verify the appeal ID. |
| `MODERATION_002` | 400 | Appeal is not in a valid state for this operation | The appeal was already resolved, the campaign is not suspended, or there is no active suspension to appeal. | Re-fetch the campaign/appeal to confirm its current moderation status before retrying. |
| `MODERATION_003` | 409 | An appeal is already in progress for this suspension | Only one open appeal is allowed per suspension. | Wait for the existing appeal to be resolved before submitting another. |
| `MODERATION_004` | 400 | Appeal message must be at least 10 characters long | The submitted appeal message is too short to be reviewed meaningfully. | Provide a longer explanation (at least 10 characters) and resubmit. |

### RECOVERY — failed refund/distribution recovery cases

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `RECOVERY_001` | 404 | Recovery case not found | No recovery case exists for the given ID. | Verify the recovery case ID. |
| `RECOVERY_002` | 400 | Recovery case is not of the expected type for this operation | The recovery case exists but its `type` (e.g. FAILED_REFUND, FAILED_DISTRIBUTION, CANCELLED_CAMPAIGN_FUNDS) does not match the action being performed. | Use the endpoint that matches the recovery case's actual type. |
| `RECOVERY_003` | 400 | Recovery case has already been resolved | The recovery case status is already RECOVERED and cannot be actioned again. | No action needed; re-fetch the case to see its resolution details. |
| `RECOVERY_004` | 400 | Recovery settlement input failed validation | The recovery case has no linked campaign, no targetCampaignId was supplied for a transfer-to-campaign settlement, or the target campaign does not exist / is not active. | Supply a valid, active targetCampaignId for transfer settlements, or choose a different settlement option. |

### WEBHOOK

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `WEBHOOK_001` | 404 | Webhook not found | No webhook (or webhook event) exists for the given ID. | Verify the webhook ID. |
| `WEBHOOK_002` | 400 | Webhook URL must use HTTPS | The provided webhook URL uses an insecure scheme (http:// or non-URL). | Provide an https:// URL for the webhook endpoint. |

### STORAGE — file/image uploads

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `STORAGE_001` | 400 | Uploaded file is empty | The uploaded buffer contained zero bytes. | Re-select the file and retry the upload. |
| `STORAGE_002` | 413 | File exceeds the maximum allowed size | The uploaded file is larger than the size limit configured for this upload type. | Compress or resize the file, or upload a smaller file. |
| `STORAGE_003` | 415 | File type is not supported for this upload | The file's detected MIME type could not be determined, or is not in the allow-list for this upload type. | Convert the file to one of the supported formats for this upload type and retry. |
| `STORAGE_004` | 422 | File appears to be corrupt or in an unsupported format | Image processing (metadata read, resize, or transcode) failed on the uploaded file. | Re-export the image from its source application and retry the upload. |
| `STORAGE_005` | 422 | Image dimensions are below the minimum required | The uploaded image is smaller than the minimum width/height configured for this upload type. | Upload a higher-resolution image that meets the minimum dimensions. |

### RECEIPT — tax receipts

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `RECEIPT_001` | 400 | Receipts can only be generated for confirmed donations | A receipt was requested for a donation that has not reached CONFIRMED status. | Wait for the donation to be confirmed before requesting a receipt. |
| `RECEIPT_002` | 422 | Cannot generate a receipt: donation has no associated donor account | The donation is not linked to a user account with an email address (e.g. a guest donation). | This donation cannot receive an emailed receipt; generate a receipt record without email delivery instead. |
| `RECEIPT_003` | 404 | Receipt not found | No tax receipt exists for the given ID. | Verify the receipt ID. |
| `RECEIPT_004` | 404 | Batch job not found | No receipt batch job exists for the given ID. | Verify the batch job ID. |

### FRAUD — model version lifecycle

| Code | HTTP | Message | Cause | Solution |
|---|---|---|---|---|
| `FRAUD_001` | 400 | FRAUD_MODEL_VERSION_NOT_READY: candidate version does not meet promotion thresholds | `promoteVersion()` was called for a candidate whose ECE/AUC have not been computed yet, or whose ECE >= 0.05 or AUC <= 0.75. | Run calibration evaluation on the candidate (see fraudCalibration.service) and retry promotion only once ECE < 0.05 and AUC > 0.75. |
| `FRAUD_002` | 404 | Fraud model version not found | No FraudModelVersion exists for the given ID. | Verify the version ID, e.g. the one returned by createCandidateVersion(). |

## Adding a new code

1. Add an entry to `ErrorCodes` in `src/constants/errorCodes.ts` with `httpStatus`, `message`, `cause`,
   and `solution`.
2. Throw it with `throw AppError.from('YOUR_CODE')`, or `throw AppError.from('YOUR_CODE', 'more specific message')`
   to keep the stable code while customizing the text for that call site.
3. Add a row to the matching domain table above (or a new domain section, following the existing
   `<DOMAIN>_<3-digit sequence>` naming convention).
4. Run `npx jest src/constants` to check the registry integrity test still passes.

Don't reuse a code across unrelated conditions just to avoid adding a new one — the whole point of
the taxonomy is that one code always means one thing.
