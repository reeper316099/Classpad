export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const notFound = (what: string, id: string) =>
  new ApiError(404, 'NOT_FOUND', `${what} "${id}" not found`);
