import { createMailRuntime, resolveEmailProvider, type LoadRecipient, type StartLetterWorkflow } from '@/mail';
import { GetContact } from '@/people/contracts';

/**
 * Mail composition for this service. Both bindings are late: the route bridge
 * and the workflow engine exist only after the features have started.
 */
let routes: ((route: unknown, input: unknown) => Promise<{ status: number; body: unknown }>) | undefined;
let starter: StartLetterWorkflow | undefined;

export function bindMailRoutes(invoke: NonNullable<typeof routes>): void {
  routes = invoke;
}
export function bindMailWorkflows(start: StartLetterWorkflow): void {
  starter = start;
}

const loadRecipient: LoadRecipient = async (personId) => {
  if (routes === undefined) throw new Error('Routes are not bound');
  const response = await routes(GetContact, { personId });
  return response.status === 200 ? (response.body as { email: string }) : undefined;
};

const startWorkflow: StartLetterWorkflow = async (input) => {
  if (starter === undefined) throw new Error('The workflow engine is not connected yet');
  return starter(input);
};

const resolution = resolveEmailProvider();
const email = resolution.kind === 'configured' ? resolution.provider : undefined;

export const mail = createMailRuntime({
  execution: {
    loadRecipient,
    startWorkflow,
    ...(email === undefined ? {} : { sendEmail: email.sendEmail }),
  },
});
