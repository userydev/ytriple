export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: { currentRevision: number },
  ) {
    super(message);
  }
}
