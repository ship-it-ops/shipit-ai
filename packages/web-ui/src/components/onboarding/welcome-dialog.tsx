'use client';

import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@ship-it-ui/ui';
import { IconGlyph, type GlyphName } from '@ship-it-ui/icons';

// Stage C4 of the auth-and-rbac milestone. Shown after the first
// successful sign-in (auth.enabled = true) so the user lands somewhere
// other than an empty graph. Distinct from the existing OnboardingDialog,
// which is specifically for the auth-disabled local-dev flow where the
// operator needs to personalize their `frontend.devUser` config.
//
// Real OIDC providers already give us identity — there's nothing for the
// user to fill in here. The dialog just orients them: where to find
// docs, where to mint a token if they're wiring up the MCP server. The
// "Got it" CTA closes the dialog and persists a flag so it doesn't
// reappear on the next page load.

interface WelcomeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display name from /api/auth/me — for a personalized greeting. */
  displayName: string;
}

export function WelcomeDialog({ open, onOpenChange, displayName }: WelcomeDialogProps) {
  const router = useRouter();
  const greeting =
    displayName.trim().length > 0 ? `Welcome, ${displayName.split(/\s+/)[0]}` : 'Welcome';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={greeting}
      description="You're signed in to ShipIt. Two things to know before you start."
      width={520}
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Got it
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Tip
          icon="document"
          title="The catalog is your home base"
          body="Browse services, find owners, jump to incident dashboards. The graph view lives one click away when you need to trace dependencies."
        />
        <Tip
          icon="bolt"
          title="Mint a token to wire up Claude Code or other agents"
          body="Settings → API Keys generates a personal access token for the MCP server. The plaintext is shown once — save it before you close the dialog."
          action={{
            label: 'Open Settings',
            onClick: () => {
              onOpenChange(false);
              router.push('/settings');
            },
          }}
        />
      </div>
    </Dialog>
  );
}

function Tip({
  icon,
  title,
  body,
  action,
}: {
  // GlyphName (not string) so an unregistered icon name fails the build
  // instead of rendering IconGlyph's literal-text fallback (the "tal" bug).
  icon: GlyphName;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="border-border flex items-start gap-3 rounded border p-3">
      <span className="text-accent shrink-0 pt-[2px]" aria-hidden>
        <IconGlyph name={icon} size={16} />
      </span>
      <div className="min-w-0">
        <div className="text-text text-[13px] font-medium">{title}</div>
        <div className="text-text-muted mt-[2px] text-[12px]">{body}</div>
        {action && (
          <div className="mt-2">
            <Button variant="outline" size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
