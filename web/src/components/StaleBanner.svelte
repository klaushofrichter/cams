<script lang="ts">
  // For admins (migration P4, M §9.4): cams has not reached cams-admin for a
  // day (it keeps working from its last configuration), or cams-admin
  // refuses this cams instance (blocked or re-enrolled elsewhere).
  import { isAdmin } from '../lib/session';
  import { me } from '../lib/stores';

  const since = $derived($me?.staleSince ? new Date($me.staleSince).toLocaleString() : '');
</script>

{#if isAdmin($me) && ($me?.configProblem || $me?.staleSince)}
  <div class="banner" role="status" data-testid="stale-banner">
    {#if $me?.configProblem === 'snapshot_older'}
      cams-admin sent an older configuration than the one in use (restored from a backup, or its clock went back): cams keeps the newer one.
    {:else if $me?.configProblem === 'file_account_changed'}
      cams-admin names this cams's home account by another id now: cams treats it as another account (its cameras wait for an admin, no stored password is used).
    {:else if $me?.configProblem}
      cams-admin no longer accepts this cams instance{$me.configProblem === 'revoked' ? ' (blocked)' : ' (its key is unknown)'}: cams keeps its last configuration. Enroll it again (admin-enroll).
    {:else}
      Configuration not refreshed since {since}. cams keeps working with it.
    {/if}
  </div>
{/if}

<style>
  .banner { margin-bottom: 16px; padding: 10px 16px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); font-size: 14px; }
</style>
