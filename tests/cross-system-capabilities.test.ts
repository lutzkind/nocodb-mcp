import { describe, expect, it } from 'vitest';
import { resolveCandidates } from '../src/tools/metadata-resolution.js';
import { redactHistoryValue } from '../src/tools/history.js';

describe('cross-system read capabilities', () => {
  it('prefers exact metadata names and refuses ambiguous partial matches', () => {
    const exact = resolveCandidates([
      { id: 'm1', name: 'Leads', kind: 'table', score: 0 },
      { id: 'm2', name: 'Leads Archive', kind: 'table', score: 0 },
    ], 'Leads');
    expect(exact.resolution_status).toBe('resolved');
    expect(exact.selected?.id).toBe('m1');

    const ambiguous = resolveCandidates([
      { id: 'm1', name: 'Leads', kind: 'table', score: 0 },
      { id: 'm2', name: 'Lead Archive', kind: 'table', score: 0 },
    ], 'Lead');
    expect(ambiguous.resolution_status).toBe('ambiguous');
    expect(ambiguous.selected).toBeNull();
  });

  it('redacts sensitive history values without fabricating unavailable history', () => {
    expect(redactHistoryValue({ actor: 'agent', api_token: 'secret', new_values: { body: 'private' } })).toEqual({
      actor: 'agent', api_token: '[REDACTED]', new_values: { body: '[REDACTED]' },
    });
  });
});
