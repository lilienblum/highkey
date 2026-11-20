// Account email: verification, password reset and invitations, sent as plain text through
// Resend's HTTP API (no tracking). Without a Resend key there is no email: verification is off,
// invitations are shared as links, and the server admin resets passwords. Also here: which
// social sign-in providers are configured.

/** Sends the account emails. */
export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** A mailer that keeps what it was asked to send, for tests. */
export function memoryMailer(): Mailer & { sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Sends through Resend (`HIGHKEY_RESEND_API_KEY`, from `HIGHKEY_EMAIL_FROM`). */
export function resendMailer(apiKey: string, from: string, fetchImpl: Fetch = fetch): Mailer {
  return {
    async send({ to, subject, text }) {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`Resend refused the email (${response.status}): ${await response.text()}`);
    },
  };
}

export type SocialProviders = {
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
};

/** GitHub and Google sign-in, each only when both its client id and secret are set. */
export function socialFromEnv(env: Record<string, string | undefined>): SocialProviders {
  const providers: SocialProviders = {};
  for (const [name, prefix] of [
    ["github", "HIGHKEY_GITHUB"],
    ["google", "HIGHKEY_GOOGLE"],
  ] as const) {
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (clientId && clientSecret) providers[name] = { clientId, clientSecret };
  }
  return providers;
}
