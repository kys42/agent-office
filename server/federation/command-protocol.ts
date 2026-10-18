import { z } from 'zod';
import { idSchema } from './protocol.js';

export const targetSchema = z
  .object({
    kind: z.enum(['orca', 'tmux', 'codex']),
    status: z.string().max(80),
    canSend: z.boolean(),
    queues: z.boolean().optional(),
  })
  .strict()
  .nullable();
export const targetResponseSchema = z
  .object({ officeId: z.uuid(), epoch: z.uuid(), targets: z.record(idSchema, targetSchema) })
  .strict();
export const sendResponseSchema = z
  .object({ officeId: z.uuid(), requestId: z.uuid(), status: z.enum(['sent', 'uncertain']) })
  .strict();
