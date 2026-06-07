'use client';

import { useEffect, useState } from 'react';
import { clientConfig } from '@/lib/client-config';
import { ONBOARDING_COMPLETE_KEY, useCurrentUserQuery } from '@/lib/current-user';
import { OnboardingDialog } from './onboarding-dialog';
import { WelcomeDialog } from './welcome-dialog';

const AUTH_ENABLED = process.env.NEXT_PUBLIC_SHIPIT_AUTH_ENABLED === 'true';
const WELCOME_SEEN_KEY = 'shipit:welcome-seen';

// Same heuristic preflight.sh uses to decide whether the local config is
// still on its example defaults. Identical strings on all three fields means
// the user hasn't personalized anything yet.
function isVerbatimDefault(): boolean {
  const u = clientConfig.devUser;
  if (!u) return true;
  return u.firstName === 'Dev' && u.lastName === 'User' && u.email === 'dev@shipit.local';
}

export function OnboardingTrigger() {
  // Two distinct flows live behind this trigger:
  //
  //   1. Auth DISABLED + verbatim-default devUser → OnboardingDialog. The
  //      operator hasn't personalized their config; we walk them through
  //      it (identity + capability checklist + optional demo seed).
  //
  //   2. Auth ENABLED + first sign-in for this browser → WelcomeDialog.
  //      Identity already came from the IdP, so no form — just a quick
  //      orientation panel ("you're in, here's where to find your token").
  //
  // Anything else (production with auth disabled, returning user with
  // auth enabled) renders nothing.
  if (AUTH_ENABLED) {
    return <AuthEnabledTrigger />;
  }
  return <AuthDisabledTrigger />;
}

function AuthDisabledTrigger() {
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

function AuthEnabledTrigger() {
  const { data, isLoading } = useCurrentUserQuery();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isLoading || !data) return;
    // Keyed by email so a shared browser (with multiple sign-ins) gets
    // the welcome panel per user. Falling back to a single global key
    // would suppress the welcome for the second user.
    const key = `${WELCOME_SEEN_KEY}:${data.email}`;
    if (window.localStorage.getItem(key) === 'true') return;
    setOpen(true);
  }, [isLoading, data]);

  if (!data) return null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && data) {
      window.localStorage.setItem(`${WELCOME_SEEN_KEY}:${data.email}`, 'true');
    }
  };

  return <WelcomeDialog open={open} onOpenChange={handleOpenChange} displayName={data.name} />;
}
