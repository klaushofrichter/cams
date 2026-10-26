// The recordings service's errors, in their own module so the proxy
// recordings client can throw them without importing the service.
export class RecordingError extends Error {
  constructor(readonly code: 'unknown_clip' | 'thumbnail_unavailable' | 'recordings_unavailable' | 'full_quality_unavailable', message: string) {
    super(message);
    this.name = 'RecordingError';
  }
}

// What an aborted wait rejects with (callers test name === 'AbortError').
export function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
