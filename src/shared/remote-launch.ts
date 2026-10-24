import { z } from 'zod';

export const launchSpecSchema = z
  .object({
    provider: z.enum(['claude', 'codex']),
    host: z.enum(['tmux', 'orca']),
    name: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\p{L}\p{N} _-]+$/u),
    initialMessage: z
      .string()
      .max(4000)
      .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/)
      .default(''),
  })
  .strict();
export type RemoteLaunchSpec = z.infer<typeof launchSpecSchema>;
export const launchInfoSchema = z
  .object({
    officeId: z.uuid(),
    epoch: z.uuid(),
    plan: z.string().regex(/^[a-f0-9]{64}$/),
    project: z.string().max(4000),
    cwd: z.string().max(4000),
    hosts: z.object({ tmux: z.boolean(), orca: z.boolean() }).strict(),
    status: z.enum(['ready', 'started', 'running', 'uncertain', 'cancelled']),
    requestId: z.uuid().optional(),
  })
  .strict();
export type RemoteLaunchInfo = z.infer<typeof launchInfoSchema> & { office: string };
