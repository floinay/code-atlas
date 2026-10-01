import * as z from 'zod/v4';
import { defineRoute, response, withHttp } from '@/platform/route-contracts';

/** Accepts a letter and queues it. Nothing is sent while the request is open. */
export const SendMail = defineRoute(
  {
    name: 'mail.send',
    input: z.strictObject({ personId: z.uuidv7(), subject: z.string() }),
    responses: [response(202, z.strictObject({ letterId: z.uuidv7() }))],
  },
  withHttp({ method: 'POST', path: '/api/mail/send' }),
);
