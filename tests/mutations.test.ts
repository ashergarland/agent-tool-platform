import { describe, expect, it } from 'vitest';
import { MutationGate, decideMutation, mutationConflict } from '@agent-tool-platform/runtime';

describe('mutation gate', () => {
  const request = { toolName: 'apply_change', dryRun: false, confirm: false };

  it('permits a preview even when mutations are disabled', () => {
    expect(
      decideMutation({ enabled: false, confirmationRequired: true }, { ...request, dryRun: true }),
    ).toEqual({ mode: 'preview' });
  });

  it('refuses execution when mutations are disabled', () => {
    expect(() => decideMutation({ enabled: false, confirmationRequired: false }, request)).toThrow(
      /mutations are disabled/u,
    );
    try {
      decideMutation({ enabled: false, confirmationRequired: false }, request);
    } catch (error) {
      expect(error).toMatchObject({ code: 'forbidden' });
      expect((error as { details?: { reason?: string } }).details?.reason).toBe(
        'mutations_disabled',
      );
    }
  });

  it('enforces confirmation when it is required', () => {
    expect(() => decideMutation({ enabled: true, confirmationRequired: true }, request)).toThrow(
      /confirm=true/u,
    );
    try {
      decideMutation({ enabled: true, confirmationRequired: true }, request);
    } catch (error) {
      expect(error).toMatchObject({ code: 'bad_request' });
    }
  });

  it('returns an execute decision only when everything is permitted', () => {
    expect(
      decideMutation({ enabled: true, confirmationRequired: true }, { ...request, confirm: true }),
    ).toEqual({ mode: 'execute' });
    expect(decideMutation({ enabled: true, confirmationRequired: false }, request)).toEqual({
      mode: 'execute',
    });
  });

  it('exposes the same decisions through the bound gate', () => {
    const gate = new MutationGate({ enabled: true, confirmationRequired: true });
    expect(gate.enabled).toBe(true);
    expect(gate.confirmationRequired).toBe(true);
    expect(gate.isPreview({ ...request, dryRun: true })).toBe(true);
    expect(gate.isPreview({ ...request, confirm: true })).toBe(false);
  });

  it('offers a conflict error for state that moved under a preview', () => {
    expect(mutationConflict('the resource changed')).toMatchObject({ code: 'conflict' });
  });
});
