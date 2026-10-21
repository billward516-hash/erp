import { z } from 'zod';

/** Assessment question bank format. Answers are stored server-side and never sent to learners. */
export const QuestionSchema = z.object({
  id: z.string().min(1).max(40),
  prompt: z.string().min(1).max(2000),
  type: z.enum(['single', 'multi', 'true_false']),
  options: z.array(z.string().min(1).max(500)).min(2).max(10),
  /** Indexes into options. */
  answer: z.array(z.number().int().nonnegative()).min(1),
  points: z.number().positive().max(100).default(1),
}).superRefine((q, ctx) => {
  if (q.answer.some((a) => a >= q.options.length)) ctx.addIssue({ code: 'custom', message: `question ${q.id}: answer index out of range` });
  if (q.type !== 'multi' && q.answer.length !== 1) ctx.addIssue({ code: 'custom', message: `question ${q.id}: exactly one correct answer required` });
  if (q.type === 'true_false' && q.options.length !== 2) ctx.addIssue({ code: 'custom', message: `question ${q.id}: true/false needs two options` });
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionBankSchema = z.array(QuestionSchema).min(1).max(200).superRefine((qs, ctx) => {
  const ids = qs.map((q) => q.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'question ids must be unique' });
});

/** Learner-facing view: no answer key. */
export function forDelivery(questions: Question[]) {
  return questions.map(({ id, prompt, type, options, points }) => ({ id, prompt, type, options, points }));
}

export interface GradeResult { score: number; earned: number; possible: number; passed: boolean; unanswered: string[] }

/**
 * Deterministic grading. Single/true-false: exact match. Multi-select: all-or-nothing (the selected set
 * must equal the key) — partial credit on safety content would reward guessing.
 */
export function grade(questions: Question[], responses: Record<string, number[]>, passingScore: number): GradeResult {
  let earned = 0;
  let possible = 0;
  const unanswered: string[] = [];
  for (const q of questions) {
    possible += q.points;
    const r = responses[q.id];
    if (!r || !r.length) { unanswered.push(q.id); continue; }
    const given = [...new Set(r)].sort((a, b) => a - b);
    const key = [...new Set(q.answer)].sort((a, b) => a - b);
    if (given.length === key.length && given.every((v, i) => v === key[i])) earned += q.points;
  }
  const score = possible ? Math.round((earned / possible) * 10000) / 100 : 0;
  return { score, earned, possible, passed: score >= passingScore, unanswered };
}
