// Where cams takes its accounts, users and cameras from (migration P4,
// M §9.4): CONFIG_SOURCE = file (the default: cameras.json and
// ALLOWED_EMAILS, exactly as before; also the rollback), shadow (file, plus
// comparing with cams-admin) or cams-admin.
export type ConfigMode = 'file' | 'shadow' | 'cams-admin';
const MODES: readonly ConfigMode[] = ['file', 'shadow', 'cams-admin'];

export function configMode(): ConfigMode {
  const v = process.env.CONFIG_SOURCE;
  if (v === undefined || v === '') return 'file';
  if ((MODES as readonly string[]).includes(v)) return v as ConfigMode;
  throw new Error('CONFIG_SOURCE must be file, shadow or cams-admin');
}
