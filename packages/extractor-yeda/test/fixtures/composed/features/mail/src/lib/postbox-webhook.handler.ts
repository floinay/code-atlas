import { providerEvents } from './mail.schema';

export const POSTBOX_WEBHOOK_PATH = '/api/mail/providers/postbox';

/** Receives deliverability events from the provider. The signature is its only authentication. */
export function postboxWebhook(options: { database: () => any }) {
  return async (ctx: any, next: () => Promise<void>) => {
    if (ctx.path !== POSTBOX_WEBHOOK_PATH) {
      await next();
      return;
    }
    if (ctx.method !== 'POST') {
      ctx.status = 405;
      return;
    }
    await options.database().insert(providerEvents).values({ id: ctx.get('Postbox-Event'), kind: 'delivered' });
    ctx.status = 204;
  };
}
