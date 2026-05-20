'use client';

import { useEffect, useState } from 'react';
import { clientConfig } from '@/lib/client-config';
import { ONBOARDING_COMPLETE_KEY } from '@/lib/current-user';
import { OnboardingDialog } from './onboarding-dialog';

// Same heuristic preflight.sh uses to decide whether the local config is
// still on its example defaults. Identical strings on all three fields means
// the user hasn't personalized anything yet.
function isVerbatimDefault(): boolean {
  const u = clientConfig.devUser;
  if (!u) return true;
  return u.firstName === 'Dev' && u.lastName === 'User' && u.email === 'dev@shipit.local';
}

export function OnboardingTrigger() {
  const [open, setOpen] = useState(false);

  // Decision happens in a one-shot effect: render nothing until we've checked
  // localStorage to avoid a hydration flash where the dialog appears, then
  // immediately closes on the client because onboarding is already complete.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!isVerbatimDefault()) return;
    const done = window.localStorage.getItem(ONBOARDING_COMPLETE_KEY);
    if (done === 'true') return;
    setOpen(true);
  }, []);

  return <OnboardingDialog open={open} onOpenChange={setOpen} />;
}
