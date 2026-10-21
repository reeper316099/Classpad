export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID' | 'CORRUPT' | 'LOCKED' | 'IO' | 'PATH' | 'ENCRYPTED' | 'DECRYPT',
    readonly file?: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
