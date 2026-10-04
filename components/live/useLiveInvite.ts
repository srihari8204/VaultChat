// components/live/useLiveInvite.ts — the host's Private Live invitation link.
//
// Moved out of app/live-view.tsx unchanged.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { createInviteLink } from '../../lib/broadcast';

export function useLiveInvite({ id, invite, waiting, failed, isOwner }: {
  id: string | undefined;
  /** Route param: '1' asks for the invitation to open once the host is live. */
  invite: string | undefined;
  waiting: boolean;
  failed: boolean;
  isOwner: boolean;
}) {
  // ── private invitation ──────────────────────────────────────────────
  //
  // THE LINK IS THE ACCESS MECHANISM: the host shares it with whoever they
  // like, rather than picking invitees from a list before they have decided who
  // to tell. Opened automatically for a Private Live because that is the whole
  // reason for choosing private — hiding it behind a menu would leave the host
  // hunting for it while already on air.
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);

  const makeInvite = useCallback(async () => {
    if (inviteBusy) return;
    setInviteBusy(true);
    try {
      const l = await createInviteLink(String(id));
      // The plaintext code exists ONLY in this response — the server keeps a
      // hash — so if it is not captured here it cannot be recovered, only
      // rotated. That is why it goes straight into state.
      if (l?.url) { setInviteUrl(l.url); setInviteOpen(true); }
      else Alert.alert('Invitation', 'Could not create an invitation link.');
    } finally { setInviteBusy(false); }
  }, [id, inviteBusy]);

  // Auto-open once, for a private stream, after the host is actually live.
  const inviteAsked = useRef(false);
  useEffect(() => {
    if (invite !== '1' || inviteAsked.current || waiting || failed || !isOwner) return;
    inviteAsked.current = true;
    void makeInvite();
  }, [invite, waiting, failed, isOwner, makeInvite]);

  return { inviteUrl, inviteOpen, setInviteOpen, inviteBusy, makeInvite };
}
