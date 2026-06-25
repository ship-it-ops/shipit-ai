'use client';

// "Report a problem" widget — a launcher fixed to the bottom-right of every
// authenticated page. Opens a short form (type/title/description), auto-collects
// the environment + recent console logs, and POSTs to /api/feedback, which files
// a GitHub issue via a server-held service identity. The reporter is attributed
// server-side from the session; we never touch the user's GitHub token.
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Dialog,
  FAB,
  Field,
  Input,
  Select,
  Textarea,
  useToast,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  fetchFeedbackConfig,
  submitFeedback,
  type FeedbackContextPayload,
  type FeedbackType,
} from '@/lib/api';
import { getRecentLogs, installConsoleCapture } from '@/lib/console-capture';

const TYPE_OPTIONS = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature request' },
  { value: 'question', label: 'Question' },
];

function collectContext(route: string): FeedbackContextPayload {
  if (typeof window === 'undefined') return { route };
  return {
    url: window.location.href,
    route,
    userAgent: window.navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    language: window.navigator.language,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || undefined,
  };
}

export function FeedbackWidget() {
  const { toast } = useToast();
  const pathname = usePathname();

  // Start capturing console output as soon as the widget mounts (it lives in
  // the authenticated layout, so this covers the whole app shell).
  useEffect(() => {
    installConsoleCapture();
  }, []);

  // Hide the launcher entirely unless the server says feedback is configured.
  const configQuery = useQuery({
    queryKey: ['feedback-config'],
    queryFn: fetchFeedbackConfig,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackType>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);

  const mutation = useMutation({
    mutationFn: () =>
      submitFeedback({
        type,
        title: title.trim(),
        description: description.trim(),
        context: includeDiagnostics ? collectContext(pathname) : { route: pathname },
        logs: includeDiagnostics ? getRecentLogs() : undefined,
      }),
    onSuccess: (result) => {
      setOpen(false);
      setTitle('');
      setDescription('');
      setType('bug');
      toast({
        variant: 'ok',
        title: 'Report filed',
        description: `Issue #${result.issueNumber} created. Thanks for the report!`,
        action: (
          <a
            className="text-accent underline"
            href={result.issueUrl}
            target="_blank"
            rel="noreferrer"
          >
            View issue
          </a>
        ),
      });
    },
    onError: (err) => {
      toast({
        variant: 'err',
        title: "Couldn't file your report",
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    },
  });

  if (!configQuery.data?.enabled) return null;

  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && !mutation.isPending;

  return (
    <>
      <div className="z-sticky fixed right-6 bottom-6">
        <FAB
          icon={<IconGlyph name="megaphone" />}
          aria-label="Report a problem"
          onClick={() => setOpen(true)}
        />
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!mutation.isPending) setOpen(next);
        }}
        title="Report a problem"
        description="Tell us what went wrong or what you'd like to see. We'll file it for the team."
        width={520}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<IconGlyph name="send" />}
              onClick={() => mutation.mutate()}
              disabled={!canSubmit}
            >
              {mutation.isPending ? 'Sending…' : 'Send report'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-text text-[12px] font-medium">Type</span>
            <Select
              options={TYPE_OPTIONS}
              value={type}
              onValueChange={(v) => setType(v as FeedbackType)}
              aria-label="Report type"
            />
          </div>

          <Field label="Title">
            {(p) => (
              <Input
                {...p}
                value={title}
                maxLength={200}
                placeholder="Short summary"
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Field>

          <Field label="Description">
            {(p) => (
              <Textarea
                {...p}
                value={description}
                rows={5}
                placeholder="What happened? What did you expect? Steps to reproduce help a lot."
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>

          <div className="border-border flex flex-col gap-1 rounded border p-3">
            <Checkbox
              checked={includeDiagnostics}
              onCheckedChange={(c) => setIncludeDiagnostics(c === true)}
              label="Include diagnostics"
            />
            <p className="text-text-dim m-0 pl-6 text-[11px]">
              Attaches this page&apos;s URL, your browser, and recent console messages. These may
              contain data shown on your screen.
            </p>
          </div>
        </div>
      </Dialog>
    </>
  );
}
