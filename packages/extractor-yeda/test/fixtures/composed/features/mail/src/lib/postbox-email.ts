export type SendEmail = (message: { to: string; subject: string }) => Promise<{ id: string }>;

type PostboxConfig = Readonly<{ token: string; apiUrl: string; fetch?: typeof globalThis.fetch }>;

/** The Postbox adapter: rendered content in, the provider's message id out. */
export function createPostboxSender(config: PostboxConfig): SendEmail {
  const send = config.fetch ?? globalThis.fetch;
  return async (message) => {
    const response = await send(config.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(message),
    });
    return (await response.json()) as { id: string };
  };
}

export function resolveEmailProvider(environment: Record<string, string | undefined> = process.env) {
  if (!environment.POSTBOX_TOKEN) return { kind: 'absent' as const };
  return {
    kind: 'configured' as const,
    provider: Object.freeze({
      sendEmail: createPostboxSender({ token: environment.POSTBOX_TOKEN, apiUrl: 'https://send.postbox.example/api/send' }),
    }),
  };
}
