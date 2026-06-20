import { PrismaClient, Role, UserStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting database seed...');

  // Create admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@aidlink.org' },
    update: {},
    create: {
      email: 'admin@aidlink.org',
      username: 'admin',
      passwordHash: '$2a$10$YourHashedPasswordHere', // Replace with actual hash
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      emailVerified: true,
    },
  });

  console.log('Created admin user:', admin.email);

  // Create test organization user
  const orgUser = await prisma.user.upsert({
    where: { email: 'org@aidlink.org' },
    update: {},
    create: {
      email: 'org@aidlink.org',
      username: 'test-org',
      passwordHash: '$2a$10$YourHashedPasswordHere',
      role: Role.ORGANIZATION,
      status: UserStatus.ACTIVE,
      emailVerified: true,
    },
  });

  // Create test organization
  const organization = await prisma.organization.upsert({
    where: { userId: orgUser.id },
    update: {},
    create: {
      userId: orgUser.id,
      name: 'Test Organization',
      description: 'A test organization for AidLink',
      website: 'https://testorg.org',
      registrationNumber: 'REG123456',
      taxId: 'TAX789012',
      status: 'APPROVED',
      verifiedAt: new Date(),
    },
  });

  console.log('Created test organization:', organization.name);

  // Create test donor
  const donor = await prisma.user.upsert({
    where: { email: 'donor@aidlink.org' },
    update: {},
    create: {
      email: 'donor@aidlink.org',
      username: 'test-donor',
      passwordHash: '$2a$10$YourHashedPasswordHere',
      role: Role.DONOR,
      status: UserStatus.ACTIVE,
      emailVerified: true,
    },
  });

  console.log('Created test donor:', donor.email);

  // Create test beneficiary
  const beneficiaryUser = await prisma.user.upsert({
    where: { email: 'beneficiary@aidlink.org' },
    update: {},
    create: {
      email: 'beneficiary@aidlink.org',
      username: 'test-beneficiary',
      passwordHash: '$2a$10$YourHashedPasswordHere',
      role: Role.BENEFICIARY,
      status: UserStatus.ACTIVE,
      emailVerified: true,
    },
  });

  const beneficiary = await prisma.beneficiary.upsert({
    where: { userId: beneficiaryUser.id },
    update: {},
    create: {
      userId: beneficiaryUser.id,
      firstName: 'John',
      lastName: 'Doe',
      dateOfBirth: new Date('1990-01-01'),
      gender: 'Male',
      nationality: 'Kenyan',
      idDocumentType: 'National ID',
      idDocumentNumber: 'ID12345678',
      phoneNumber: '+254700000000',
      address: '123 Test Street, Nairobi',
      city: 'Nairobi',
      country: 'Kenya',
      coordinates: JSON.stringify({ lat: -1.2921, lng: 36.8219 }),
      familySize: 4,
      status: 'VERIFIED',
      verifiedAt: new Date(),
      riskScore: 10,
    },
  });

  console.log('Created test beneficiary:', beneficiary.firstName, beneficiary.lastName);

  // Create test campaign
  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      userId: orgUser.id,
      title: 'Emergency Relief Fund',
      description: 'Providing emergency relief to affected communities',
      imageUrl: 'https://example.com/campaign-image.jpg',
      targetAmount: 100000,
      currentAmount: 0,
      startDate: new Date(),
      endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
      status: 'ACTIVE',
    },
  });

  console.log('Created test campaign:', campaign.title);

  // Create a suspended campaign to exercise the moderation workflow.
  const suspendedCampaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      userId: orgUser.id,
      title: 'Flagged Relief Campaign',
      description: 'A campaign suspended pending moderation review for demonstration purposes',
      targetAmount: 50000,
      currentAmount: 0,
      startDate: new Date(),
      status: 'SUSPENDED',
      suspendedAt: new Date(),
      suspensionMetadata: {
        reasonCode: 'FRAUD_REPORTS',
        source: 'AUTO',
      },
    },
  });

  await prisma.fraudReport.create({
    data: {
      campaignId: suspendedCampaign.id,
      reporterId: donor.id,
      type: 'SCAM',
      details: 'Suspected misuse of funds',
    },
  });

  const suspension = await prisma.suspension.create({
    data: {
      campaignId: suspendedCampaign.id,
      actorId: null,
      source: 'AUTO',
      reasonCode: 'FRAUD_REPORTS',
      reasonText: 'Multiple independent fraud reports received',
      active: true,
    },
  });

  await prisma.appeal.create({
    data: {
      suspensionId: suspension.id,
      campaignId: suspendedCampaign.id,
      campaignOwnerId: orgUser.id,
      message: 'We believe this suspension is in error and request a review.',
      status: 'OPEN',
    },
  });

  console.log('Created suspended demo campaign with suspension and appeal:', suspendedCampaign.title);

  console.log('Database seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
