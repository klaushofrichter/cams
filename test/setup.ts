// Dummy values so every test runs against a fully configured app. None are
// real credentials; production gets its own from the cams-oauth Secret.
process.env.COOKIE_SECRET ??= 'test-cookie-secret-not-used-for-anything-real';
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI ??= 'http://localhost:8080/auth/google/callback';
process.env.ALLOWED_EMAILS ??= 'klaus@klaushofrichter.net';
