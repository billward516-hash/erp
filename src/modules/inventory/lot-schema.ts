import { z } from 'zod';

/** Lots or serial numbers in a request body (D-147): optional out of stock (first-expiring is used), required into stock for tracked parts. */
export const LotsBody = z.array(z.object({ lot: z.string().min(1).max(60), qty: z.number().positive(), expiresOn: z.string().date().nullable().optional(),
  supplierLot: z.string().max(60).nullable().optional(), madeOn: z.string().date().nullable().optional() })).max(1000).nullable().optional();
