import { describe, it, expect } from 'vitest';
import { makeSecretStore } from '../../secrets/index.js';
import { FileSecretStore } from '../../secrets/file-store.js';
import { GsmSecretStore } from '../../secrets/gsm-store.js';

describe('makeSecretStore', () => {
  it('defaults to file mode', () => {
    expect(makeSecretStore({} as NodeJS.ProcessEnv)).toBeInstanceOf(FileSecretStore);
  });

  it('builds the GSM store when SHIPIT_SECRET_STORE=gsm', () => {
    const store = makeSecretStore({
      SHIPIT_SECRET_STORE: 'gsm',
      GOOGLE_CLOUD_PROJECT: 'proj',
    } as NodeJS.ProcessEnv);
    expect(store).toBeInstanceOf(GsmSecretStore);
  });

  it('fails loudly when gsm is selected without GOOGLE_CLOUD_PROJECT', () => {
    expect(() => makeSecretStore({ SHIPIT_SECRET_STORE: 'gsm' } as NodeJS.ProcessEnv)).toThrow(
      /GOOGLE_CLOUD_PROJECT/,
    );
  });

  it('rejects unknown store kinds', () => {
    expect(() => makeSecretStore({ SHIPIT_SECRET_STORE: 'vault' } as NodeJS.ProcessEnv)).toThrow(
      /Unknown SHIPIT_SECRET_STORE/,
    );
  });
});
