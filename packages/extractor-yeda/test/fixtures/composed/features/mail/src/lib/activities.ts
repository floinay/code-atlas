import { eq } from 'drizzle-orm';
import { deliveries, outbox } from './mail.schema';
import type { SendEmail } from './postbox-email';

export type LoadRecipient = (personId: string) => Promise<{ email: string } | undefined>;
export type MailActivityDependencies = Readonly<{
  database: () => any;
  loadRecipient: LoadRecipient;
  /** Absent until a provider is configured. */
  sendEmail?: SendEmail;
}>;

export function createMailActivities(dependencies: MailActivityDependencies) {
  /** Decides who gets the letter and records one delivery to make. */
  async function prepareLetter(input: { letterId: string }) {
    const database = dependencies.database();
    const recipient = await dependencies.loadRecipient(input.letterId);
    await database.insert(deliveries).values({ id: input.letterId, letterId: input.letterId, status: recipient ? 'prepared' : 'skipped' });
    return { deliveryId: input.letterId };
  }

  async function deliverLetter(input: { deliveryId: string }) {
    const database = dependencies.database();
    const status = await deliverEmail({ dependencies, deliveryId: input.deliveryId });
    await database.update(deliveries).set({ status }).where(eq(deliveries.id, input.deliveryId));
  }

  async function completeLetter(input: { letterId: string }) {
    await dependencies.database().update(outbox).set({ status: 'done' }).where(eq(outbox.id, input.letterId));
  }

  return Object.freeze({ prepareLetter, deliverLetter, completeLetter });
}

async function deliverEmail(input: { dependencies: MailActivityDependencies; deliveryId: string }) {
  const { sendEmail } = input.dependencies;
  if (sendEmail === undefined) return 'failed';
  await sendEmail({ to: input.deliveryId, subject: 'A letter' });
  return 'submitted';
}
