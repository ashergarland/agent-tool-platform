// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, deriveAgentId } from '../src/client/App.js';
import { buildResultFixture, catalogFixture, jsonResponse } from './fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

describe('Agent Builder UI', () => {
  it('derives the preferred stable technical ID from the agent name', () => {
    expect(deriveAgentId('Developer Optimization Agent')).toBe('developer-optimization');
    expect(deriveAgentId('  Release & Evidence Agent  ')).toBe('release-evidence');
  });

  it('renders the real catalog surface and supports preset selection changes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (requestUrl(input).endsWith('/api/capabilities')) {
        return jsonResponse(catalogFixture);
      }
      throw new Error(`Unexpected request: ${requestUrl(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /AST Summarizer/i });
    await user.click(screen.getByRole('button', { name: /Developer Optimization preset/i }));

    expect(screen.getByRole('textbox', { name: 'Agent name' })).toHaveProperty(
      'value',
      'Developer Optimization Agent',
    );
    expect(screen.getByRole('textbox', { name: /^Agent ID/u })).toHaveProperty(
      'value',
      'developer-optimization',
    );
    expect(screen.getByText('7 selected')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /AST Summarizer/i }));
    expect(screen.getByText('6 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /AST Summarizer/i }));
    expect(screen.getByText('7 selected')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Capabilities' }));
    expect(
      await screen.findByRole('heading', { name: 'Capabilities built for focused work.' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Azure Agent Tool Server' })).toBeTruthy();
  });

  it('shows loading, successful Build results, readiness, and exact artifact previews', async () => {
    let resolveBuild: ((response: Response) => void) | undefined;
    const pendingBuild = new Promise<Response>((resolve) => {
      resolveBuild = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input);
        if (url.endsWith('/api/capabilities')) return jsonResponse(catalogFixture);
        if (url.endsWith('/api/build') && init?.method === 'POST') return pendingBuild;
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Developer Optimization preset/i });
    await user.click(screen.getByRole('button', { name: /Developer Optimization preset/i }));
    await user.click(screen.getByRole('button', { name: 'Build agent' }));

    expect(screen.getByRole('button', { name: /Building composition/i })).toHaveProperty(
      'disabled',
      true,
    );
    resolveBuild?.(jsonResponse(buildResultFixture));

    expect(await screen.findByText('Build complete')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Developer Optimization Agent' })).toBeTruthy();
    expect(screen.getByText('Built, not prepared')).toBeTruthy();
    expect(screen.getByText('Configuration required')).toBeTruthy();
    expect(screen.getByText('7 MCP servers configured')).toBeTruthy();
    expect(screen.getByText('.github/agents/developer-optimization.agent.md')).toBeTruthy();
    expect(screen.getByText('{"kind":"agent-lock"}')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Prepare · coming next/i })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('preserves structured Agent Kit build errors without stack traces', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.endsWith('/api/capabilities')) return jsonResponse(catalogFixture);
      if (url.endsWith('/api/build')) {
        return jsonResponse(
          {
            error: {
              code: 'INCOMPATIBLE_BINDING',
              summary: 'The selected composition is not compatible with VS Code.',
              issues: ['example/profile: unsupported interface'],
            },
          },
          400,
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Developer Optimization preset/i });
    await user.click(screen.getByRole('button', { name: /Developer Optimization preset/i }));
    await user.click(screen.getByRole('button', { name: 'Build agent' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('INCOMPATIBLE_BINDING');
    expect(alert.textContent).toContain('not compatible with VS Code');
    expect(alert.textContent).not.toContain(' at ');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Build agent' })).toHaveProperty('disabled', false);
    });
  });

  it('presents a structured HTTP 500 as a Builder request failure', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.endsWith('/api/capabilities')) return jsonResponse(catalogFixture);
      if (url.endsWith('/api/build')) {
        return jsonResponse(
          {
            error: {
              code: 'BUILD_FAILED',
              summary: 'The Builder request could not be completed.',
              issues: [],
            },
          },
          500,
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Developer Optimization preset/i });
    await user.click(screen.getByRole('button', { name: /Developer Optimization preset/i }));
    await user.click(screen.getByRole('button', { name: 'Build agent' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('BUILD_FAILED');
    expect(alert.textContent).toContain('The Builder request could not be completed.');
    expect(alert.textContent).not.toContain('server is unavailable');
  });

  it('reports a network rejection as an unavailable local Builder server', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.endsWith('/api/capabilities')) return jsonResponse(catalogFixture);
      if (url.endsWith('/api/build')) throw new TypeError('fetch failed');
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Developer Optimization preset/i });
    await user.click(screen.getByRole('button', { name: /Developer Optimization preset/i }));
    await user.click(screen.getByRole('button', { name: 'Build agent' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Agent Builder server is unavailable.');
    expect(alert.textContent).toContain('Check that the local Builder process is still running.');
    expect(alert.textContent).not.toContain('fetch failed');
    expect(alert.textContent).not.toContain('The agent build failed.');
  });
});
