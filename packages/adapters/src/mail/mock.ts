import type { HealthStatus, MailMessage, MailSource } from '../types.js';

/** Mail from JSON fixtures shaped like Graph messages (docs/14 section 5). Bodies stay in memory only. */
export class FixtureMailSource implements MailSource {
  readonly info = { name: 'mail.fixtures', kind: 'mock', killSwitch: 'adapter.mail' } as const;
  constructor(private readonly messages: readonly MailMessage[]) {}

  listMessages(mailbox: string, sinceIso: string): Promise<MailMessage[]> {
    return Promise.resolve(
      this.messages.filter((m) => m.receivedAt >= sinceIso && m.to.includes(mailbox)),
    );
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ ok: true, detail: `${this.messages.length} fixture messages` });
  }
}
