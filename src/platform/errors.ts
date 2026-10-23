export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (permission: string) =>
  new AppError(403, 'forbidden', `missing permission: ${permission}`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const invalid = (message: string, details?: unknown) => new AppError(422, 'invalid', message, details);
