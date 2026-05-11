import type { CanonicalNode } from '@shipit-ai/shared';
import { isValidCanonicalId } from '@shipit-ai/shared';
import type { LinkingKeyIndex } from './linking-key-index.js';

export interface ReconciliationResult {
  action: 'create' | 'merge';
  canonicalId: string;
  matchMethod: 'primary_key' | 'linking_key';
}

export class IdentityReconciler {
  private readonly linkingKeyIndex: LinkingKeyIndex;

  constructor(linkingKeyIndex: LinkingKeyIndex) {
    this.linkingKeyIndex = linkingKeyIndex;
  }

  async reconcile(node: CanonicalNode): Promise<ReconciliationResult> {
    // Step 1: Primary Key Match
    if (isValidCanonicalId(node.id)) {
      const exists = await this.linkingKeyIndex.hasCanonicalId(node.id);
      if (exists) {
        return {
          action: 'merge',
          canonicalId: node.id,
          matchMethod: 'primary_key',
        };
      }
    }

    // Step 2: Linking Key Match
    if (node._source_id) {
      const existingId = await this.linkingKeyIndex.lookupByLinkingKey(node._source_id);
      if (existingId) {
        return {
          action: 'merge',
          canonicalId: existingId,
          matchMethod: 'linking_key',
        };
      }
    }

    // No match found: create new entity
    // Register the linking key for future lookups
    await this.linkingKeyIndex.register(node.id, node._source_id);

    return {
      action: 'create',
      canonicalId: node.id,
      matchMethod: 'primary_key',
    };
  }
}
