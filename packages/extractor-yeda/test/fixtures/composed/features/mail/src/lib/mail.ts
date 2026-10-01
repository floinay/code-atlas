import { SendMail } from '@/mail/contracts';
import { defineFeature, localRoute, withRoutes, withStart } from '@/platform/backend';
import { createMailActivities, type MailActivityDependencies } from './activities';
import { outbox } from './mail.schema';
import { postboxWebhook } from './postbox-webhook.handler';
import { createRelay, startRelayLoop, type StartLetterWorkflow } from './relay';

export type MailExecutionOptions = Readonly<
  Omit<MailActivityDependencies, 'database'> & { startWorkflow?: StartLetterWorkflow }
>;

/**
 * The feature, and the activities to register on the service worker. Execution
 * is optional: without it letters are accepted and wait in the outbox.
 */
export function createMailRuntime(options: { readonly execution?: MailExecutionOptions } = {}) {
  let database: any;
  const resolveDatabase = () => database;

  const feature = defineFeature('mail', () => [
    withRoutes([
      localRoute(SendMail, async (input: any) => {
        await database.insert(outbox).values({ id: input.personId, personId: input.personId, status: 'pending' });
        return { status: 202 as const, body: { letterId: input.personId } };
      }),
    ]),
    withStart(({ db }: any) => {
      database = db;
      const execution = options.execution;
      if (execution?.startWorkflow !== undefined) {
        startRelayLoop({ relay: createRelay({ database: resolveDatabase, startWorkflow: execution.startWorkflow }) });
      }
      return { middleware: postboxWebhook({ database: resolveDatabase }) };
    }),
  ]);

  return Object.freeze({
    feature,
    activities: () => {
      const execution = options.execution;
      if (execution === undefined) throw new Error('Mail execution is not configured');
      return createMailActivities({ ...execution, database: resolveDatabase });
    },
  });
}

/** The feature on its own: it owns its schema and accepts letters. */
export const mailFeature = createMailRuntime().feature;
