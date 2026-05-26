import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { AuthResult } from '@shipit-ai/connector-sdk';

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  installationId: string;
}

export interface GitHubAppJWTCredentials {
  appId: string;
  privateKey: string;
}

export interface GitHubPATCredentials {
  token: string;
}

// App-JWT-only Octokit, no installation context. Use this for endpoints
// that authenticate as the App itself rather than an installation —
// notably `GET /app` (getAuthenticated) and `GET /app/installations`
// (listInstallations). For data-fetching against a specific org, use
// authenticateGitHubApp instead, which mints an installation token.
export function createAppJWTOctokit(credentials: GitHubAppJWTCredentials): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: credentials.appId,
      privateKey: credentials.privateKey,
    },
  });
}

export async function authenticateGitHubApp(
  credentials: GitHubAppCredentials,
): Promise<{ auth: AuthResult; octokit: Octokit | null }> {
  try {
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: credentials.appId,
        privateKey: credentials.privateKey,
        installationId: credentials.installationId,
      },
    });

    // Verify auth by fetching the installation
    await octokit.rest.apps.getInstallation({
      installation_id: Number(credentials.installationId),
    });

    return {
      auth: { success: true },
      octokit,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      auth: { success: false, error: `GitHub App auth failed: ${message}` },
      octokit: null,
    };
  }
}

export async function authenticatePAT(
  credentials: GitHubPATCredentials,
): Promise<{ auth: AuthResult; octokit: Octokit | null }> {
  try {
    const octokit = new Octokit({ auth: credentials.token });

    // Verify auth by fetching the authenticated user
    await octokit.rest.users.getAuthenticated();

    return {
      auth: { success: true },
      octokit,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      auth: { success: false, error: `PAT auth failed: ${message}` },
      octokit: null,
    };
  }
}
