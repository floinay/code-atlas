import * as z from 'zod/v4';
import { defineRoute, response } from '@/platform/route-contracts';

export const Contact = z.strictObject({ email: z.email(), language: z.string() });

/** In-process: how another feature learns where to reach a person. */
export const GetContact = defineRoute({
  name: 'people.contact',
  input: z.strictObject({ personId: z.uuidv7() }),
  responses: [response(200, Contact)],
});
