import { GetContact } from '@/people/contracts';
import { defineFeature, localRoute, withRoutes } from '@/platform/backend';
import { people } from './people.schema';

export const createPeopleFeature = (db: any) =>
  defineFeature('people', () => [
    withRoutes([
      localRoute(GetContact, async () => ({ status: 200 as const, body: (await db.select().from(people))[0] })),
    ]),
  ]);
export const peopleFeature = createPeopleFeature(undefined);
