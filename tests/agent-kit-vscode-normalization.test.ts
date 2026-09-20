import { describe, expect, it } from 'vitest';
import {
  collapseToHyphens,
  hostId,
  inputId,
  trimHyphens,
} from '../packages/agent-kit/src/vscode.js';

/**
 * Regression coverage for the linear id-normalization helpers that replaced the
 * collapse-then-trim regex pair CodeQL flagged as a polynomial ReDoS risk in `hostId`/`inputId`
 * (both operate on registry-derived, effectively uncontrolled strings). These tests pin the exact
 * intended behavior of the replacement, including the pre-existing quirks of each caller (`hostId`
 * never folds case; `inputId` folds case but only trims trailing hyphens from the composed id).
 */
describe('vscode id normalization', () => {
  describe('hostId', () => {
    it('leaves an ordinary lowercase id unchanged', () => {
      expect(hostId('ast-summarizer')).toBe('ast-summarizer');
    });

    it('treats uppercase letters as invalid and collapses them like other separators', () => {
      // hostId never folds case: capability/agent ids are already validated lowercase by the
      // schema, so uppercase characters here are collapsed exactly like punctuation would be.
      expect(hostId('AST')).toBe('');
      expect(hostId('astSummarizer')).toBe('ast-ummarizer');
    });

    it('collapses spaces and punctuation into single hyphens', () => {
      expect(hostId('git optimizer!!')).toBe('git-optimizer');
      expect(hostId('doc_rag.tool')).toBe('doc-rag-tool');
    });

    it('collapses repeated separators into one hyphen', () => {
      expect(hostId('foo---bar')).toBe('foo-bar');
      expect(hostId('foo' + '-'.repeat(5_000) + 'bar')).toBe('foo-bar');
    });

    it('trims leading separators', () => {
      expect(hostId('---foo')).toBe('foo');
      expect(hostId('!!!foo')).toBe('foo');
    });

    it('trims trailing separators', () => {
      expect(hostId('foo---')).toBe('foo');
      expect(hostId('foo!!!')).toBe('foo');
    });

    it('handles long runs of invalid characters without changing the linear result', () => {
      const longRun = '$'.repeat(50_000);
      expect(hostId(`${longRun}foo${longRun}bar${longRun}`)).toBe('foo-bar');
    });

    it('collapses mixed alphanumeric and separator input deterministically', () => {
      expect(hostId('a1-b2_c3.d4/e5')).toBe('a1-b2-c3-d4-e5');
    });

    it('produces an empty string when every character is invalid', () => {
      expect(hostId('---')).toBe('');
      expect(hostId('!!!')).toBe('');
    });
  });

  describe('inputId', () => {
    it('folds case and joins the server id with a single hyphen', () => {
      expect(inputId('vision', 'VISION_TOKEN')).toBe('vision-vision-token');
    });

    it('leaves an ordinary lowercase value unchanged after the server prefix', () => {
      expect(inputId('git-optimizer', 'api-key')).toBe('git-optimizer-api-key');
    });

    it('collapses spaces and punctuation in the value into single hyphens', () => {
      expect(inputId('azure', 'Connector API Key!!')).toBe('azure-connector-api-key');
    });

    it('collapses repeated separators in the value into one hyphen', () => {
      expect(inputId('azure', 'a' + '_'.repeat(5_000) + 'b')).toBe('azure-a-b');
    });

    it('does not trim a leading separator produced by the value, unlike hostId', () => {
      // inputId only trims trailing hyphens from the fully composed id, so a value that
      // normalizes to a leading hyphen produces a doubled hyphen after the server prefix. This
      // is a pre-existing quirk of the original regex-based implementation, preserved exactly.
      expect(inputId('azure', '!!!token')).toBe('azure--token');
    });

    it('trims trailing separators from the composed id', () => {
      expect(inputId('azure', 'token!!!')).toBe('azure-token');
      expect(inputId('azure', 'token' + '-'.repeat(5_000))).toBe('azure-token');
    });

    it('handles long runs of invalid characters in the value', () => {
      // No leading invalid run here (unlike the dedicated leading-separator case above) so this
      // isolates the long-run collapse behavior from the doubled-hyphen quirk.
      const longRun = '$'.repeat(50_000);
      expect(inputId('azure', `foo${longRun}bar${longRun}`)).toBe('azure-foo-bar');
    });

    it('collapses mixed alphanumeric and separator values deterministically', () => {
      expect(inputId('vision', 'A1-B2_C3.D4/E5')).toBe('vision-a1-b2-c3-d4-e5');
    });

    it('produces just the trimmed server id when the value is entirely invalid', () => {
      expect(inputId('azure', '---')).toBe('azure');
      expect(inputId('azure', '!!!')).toBe('azure');
    });
  });

  describe('collapseToHyphens and trimHyphens directly', () => {
    it('collapseToHyphens never introduces adjacent hyphens', () => {
      const result = collapseToHyphens('a!!!b   c___d', true);
      expect(result).toBe('a-b-c-d');
      expect(result.includes('--')).toBe(false);
    });

    it('collapseToHyphens without lowercase folding rejects uppercase like other invalid characters', () => {
      // No trimming happens here (that is trimHyphens' job), so a leading invalid character
      // ('F' is rejected because folding is disabled) still produces a leading hyphen.
      expect(collapseToHyphens('Foo Bar', false)).toBe('-oo-ar');
    });

    it('trimHyphens trims independently on each side', () => {
      expect(trimHyphens('--foo--', true, true)).toBe('foo');
      expect(trimHyphens('--foo--', true, false)).toBe('foo--');
      expect(trimHyphens('--foo--', false, true)).toBe('--foo');
      expect(trimHyphens('--foo--', false, false)).toBe('--foo--');
    });

    it('runs in time proportional to input length for pathological separator-heavy input', () => {
      const pathological = '-'.repeat(200_000);
      const start = performance.now();
      const result = collapseToHyphens(pathological, true);
      const elapsedMs = performance.now() - start;
      expect(result).toBe('');
      expect(elapsedMs).toBeLessThan(500);
    });
  });
});
