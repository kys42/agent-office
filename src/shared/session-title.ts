import { z } from 'zod';

export const sessionTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const titleInfoSchema = z
  .object({
    available: z.boolean(),
    title: z.string().max(4000),
    reason: z.enum(['unsupported', 'source', 'connection', 'permission']).optional(),
    status: z.enum(['ready', 'renamed', 'uncertain']),
  })
  .strict();
export type SessionTitleInfo = z.infer<typeof titleInfoSchema>;
export const titleRequestSchema = z
  .object({
    title: sessionTitleSchema,
    expected: z.string().max(4000),
    requestId: z.uuid(),
  })
  .strict();
export type SessionTitleRequest = z.infer<typeof titleRequestSchema>;
