// Read per call so a changed Secret takes effect after a restart without a
// code path that could cache a stale list.
export function getAllowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
}
