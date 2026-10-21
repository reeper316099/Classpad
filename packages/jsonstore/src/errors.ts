export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID' | 'CORRUPT' | 'LOCKED' | 'IO' | 'PATH',
    readonly file?: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
