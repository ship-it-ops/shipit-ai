// Backs the in-app "Report a problem" widget (routes/feedback.ts).
//
// Files a GitHub issue in the configured product repo using a SERVER-HELD
// fine-grained PAT (FEEDBACK_GITHUB_TOKEN, issues:write) — never the logged-in
// user's identity. The login OAuth token is discarded after profile read,
// carries only user:email scope, OIDC/dev users have none, and portal users
// aren't repo collaborators; a service identity is the only viable filer. The
// reporter is still attributed in the issue body from their session.
//
// The PAT is never logged. Browser-sourced console logs are redacted for
// obvious secrets before they land in the (public-repo) issue body.
import type { Redis } from 'ioredis';
import { authenticatePAT } from '@shipit-ai/connector-github';

// Derive the Octokit type transitively through connector-github (already a
// dependency) so api-server needn't take a direct @octokit/rest dependency.
type AuthedOctokit = NonNullable<Awaited<ReturnType<typeof authenticatePAT>>['octokit']>;

export type FeedbackType = 'bug' | 'feature' | 'question';

export const FEEDBACK_TYPES: readonly FeedbackType[] = ['bug', 'feature', 'question'];

// Caps — defensive against oversized payloads and GitHub's ~65k issue-body
// limit. Title/description are also guarded in the route.
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_LOGS = 200;
const MAX_LOG_MESSAGE = 1000;
const MAX_LOGS_BLOCK = 20000;

export interface FeedbackReporter {
  email: string;
  displayName?: string;
  provider?: string;
  role?: string;
}

export interface FeedbackContext {
  url?: string;
  route?: string;
  userAgent?: string;
  viewport?: string;
  language?: string;
  appVersion?: string;
}

export interface FeedbackLog {
  level: string;
  message: string;
  ts?: number;
}

export interface FeedbackInput {
  type: FeedbackType;
  title: string;
  description: string;
  context?: FeedbackContext;
  logs?: FeedbackLog[];
  reporter: FeedbackReporter;
}

// Live reference to config.feedback — see live-reference-for-hot-reload.
export interface FeedbackConfigView {
  enabled: boolean;
  repo: { owner: string; name: string };
  defaultLabels: string[];
}

export interface FeedbackServiceOptions {
  feedback: FeedbackConfigView;
  env?: NodeJS.ProcessEnv;
  // Per-user rate limiting; when absent (Redis-less) the limiter is a no-op.
  redis?: Redis | null;
  // Injectable for tests — defaults to a real PAT-authenticated Octokit.
  octokitForToken?: (token: string) => Promise<AuthedOctokit>;
}

export class FeedbackDisabledError extends Error {
  constructor() {
    super('Feedback is not configured on this deployment.');
    this.name = 'FeedbackDisabledError';
  }
}

export class IssueCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueCreateError';
  }
}

const TYPE_LABEL: Record<FeedbackType, string> = {
  bug: 'bug',
  feature: 'feature',
  question: 'question',
};

const TYPE_HEADING: Record<FeedbackType, string> = {
  bug: 'Bug report',
  feature: 'Feature request',
  question: 'Question',
};

export class FeedbackService {
  private readonly feedback: FeedbackConfigView;
  private readonly env: NodeJS.ProcessEnv;
  private readonly redis?: Redis | null;
  private readonly octokitForToken: (token: string) => Promise<AuthedOctokit>;

  constructor(opts: FeedbackServiceOptions) {
    this.feedback = opts.feedback;
    this.env = opts.env ?? process.env;
    this.redis = opts.redis;
    this.octokitForToken = opts.octokitForToken ?? defaultOctokitForToken;
  }

  private token(): string | undefined {
    const t = this.env.FEEDBACK_GITHUB_TOKEN;
    return t && t.trim() ? t.trim() : undefined;
  }

  // Enabled only when explicitly turned on, a target repo is set, AND the
  // issue-filing token is present.
  isEnabled(): boolean {
    return Boolean(
      this.feedback.enabled && this.feedback.repo.owner && this.feedback.repo.name && this.token(),
    );
  }

  // Per-user cooldown to blunt accidental/abusive spam. Returns true when the
  // submission is allowed. No-op (always allowed) without Redis.
  async checkRateLimit(userId: string, windowSeconds = 60): Promise<boolean> {
    if (!this.redis || !userId) return true;
    // Avoid ':' in the key (BullMQ-5 scar is queue-scoped, but we keep the
    // house convention of '-'-delimited keys consistent across Redis surfaces).
    const key = `feedback-rl-${userId}`;
    try {
      const res = await this.redis.set(key, '1', 'EX', windowSeconds, 'NX');
      return res === 'OK';
    } catch {
      // A Redis blip must not block legitimate feedback — fail open.
      return true;
    }
  }

  async createReport(input: FeedbackInput): Promise<{ issueUrl: string; issueNumber: number }> {
    const token = this.token();
    if (!this.isEnabled() || !token) throw new FeedbackDisabledError();

    const octokit = await this.octokitForToken(token);
    const title = `[${TYPE_LABEL[input.type]}] ${input.title.trim()}`.slice(0, MAX_TITLE + 16);
    const body = buildIssueBody(input);
    const labels = dedupe([...this.feedback.defaultLabels, TYPE_LABEL[input.type]]);

    try {
      const { data } = await octokit.rest.issues.create({
        owner: this.feedback.repo.owner,
        repo: this.feedback.repo.name,
        title,
        body,
        labels,
      });
      return { issueUrl: data.html_url, issueNumber: data.number };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new IssueCreateError(`GitHub issue creation failed: ${message}`);
    }
  }
}

async function defaultOctokitForToken(token: string): Promise<AuthedOctokit> {
  const { octokit, auth } = await authenticatePAT({ token });
  if (!octokit) throw new IssueCreateError(auth.error ?? 'GitHub PAT authentication failed');
  return octokit;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v && v.trim()))];
}

// Strip obvious secrets that a browser console may have logged before the text
// reaches a (potentially public) GitHub issue. Best-effort — not a guarantee.
export function redactSecrets(text: string): string {
  return text
    .replace(/\bgh[posure_][A-Za-z0-9_]{20,}\b/g, '[redacted-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9._\-]{20,}\b/g, '[redacted-jwt]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted-hex]');
}

// Build the markdown issue body. Exported for unit testing.
export function buildIssueBody(input: FeedbackInput): string {
  const { type, description, context, logs, reporter } = input;
  const lines: string[] = [];

  lines.push(`**${TYPE_HEADING[type]}**`, '');
  lines.push('## Description', '');
  lines.push(redactSecrets(description.trim()).slice(0, MAX_DESCRIPTION), '');

  lines.push('## Environment', '');
  const env: Array<[string, string | undefined]> = [
    ['Reported by', reporter.email],
    ['Auth provider', reporter.provider],
    ['Role', reporter.role],
    ['Page', context?.url],
    ['Route', context?.route],
    ['Browser', context?.userAgent],
    ['Viewport', context?.viewport],
    ['Language', context?.language],
    ['App version', context?.appVersion],
  ];
  for (const [label, value] of env) {
    if (value && value.trim()) lines.push(`- **${label}:** ${sanitizeInline(value)}`);
  }
  lines.push('');

  const captured = (logs ?? []).slice(-MAX_LOGS);
  if (captured.length > 0) {
    lines.push('## Console logs', '');
    lines.push('<details><summary>Recent console messages</summary>', '');
    lines.push('```');
    let block = '';
    for (const log of captured) {
      const msg = redactSecrets(String(log.message ?? '')).slice(0, MAX_LOG_MESSAGE);
      const entry = `[${log.level}] ${msg}\n`;
      if (block.length + entry.length > MAX_LOGS_BLOCK) {
        block += '… (truncated)\n';
        break;
      }
      block += entry;
    }
    lines.push(block.trimEnd());
    lines.push('```', '', '</details>');
  }

  lines.push('', '---', '_Filed from the in-app “Report a problem” widget._');
  return lines.join('\n');
}

// Keep user-supplied single-line values from breaking the markdown list (strip
// newlines + backticks); the body is plain text in a public repo.
function sanitizeInline(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, "'")
    .slice(0, 500);
}
