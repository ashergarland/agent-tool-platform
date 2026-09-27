// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentDefinition } from '@agent-tool-platform/agent-kit';
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

const postedDefinition = (calls: readonly (readonly unknown[])[]): AgentDefinition => {
  const buildCall = calls.find((call) =>
    requestUrl(call[0] as RequestInfo | URL).endsWith('/api/build'),
  );
  const body = (buildCall?.[1] as RequestInit | undefined)?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON Builder request body.');
  return (JSON.parse(body) as { readonly definition: AgentDefinition }).definition;
};

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
    const policyGroup = screen.getByRole('group', { name: 'Execution policy' });
    expect(within(policyGroup).getByRole('radio', { name: /^Automatic/u })).toHaveProperty(
      'checked',
      true,
    );
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
    expect(within(policyGroup).getByRole('radio', { name: /^Custom/u })).toHaveProperty(
      'checked',
      true,
    );

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

  it('keeps Automatic profile-free in the canonical Build request', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input);
        if (url.endsWith('/api/capabilities')) return jsonResponse(catalogFixture);
        if (url.endsWith('/api/build') && init?.method === 'POST') {
          return jsonResponse(buildResultFixture);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /AST Summarizer/i });
    await user.type(screen.getByRole('textbox', { name: 'Agent name' }), 'Research Agent');
    await user.type(
      screen.getByRole('textbox', { name: /Instructions/u }),
      'Use bounded evidence.',
    );
    await user.click(screen.getByRole('button', { name: /AST Summarizer/i }));
    await user.click(screen.getByRole('button', { name: 'Build agent' }));
    await screen.findByText('Build complete');

    expect(postedDefinition(fetchMock.mock.calls).capabilities).toEqual([{ id: 'ast-summarizer' }]);
  });

  it('writes explicit local profiles for Local only builds', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input);
        if (url.endsWith('/api/capabilities')) return jsonResponse(catalogFixture);
        if (url.endsWith('/api/build') && init?.method === 'POST') {
          return jsonResponse(buildResultFixture);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /AST Summarizer/i });
    await user.type(screen.getByRole('textbox', { name: 'Agent name' }), 'Local Analysis Agent');
    await user.type(
      screen.getByRole('textbox', { name: /Instructions/u }),
      'Analyze only with local capabilities.',
    );
    await user.click(screen.getByRole('button', { name: /AST Summarizer/i }));
    await user.click(screen.getByRole('button', { name: /Vision/i }));
    const policyGroup = screen.getByRole('group', { name: 'Execution policy' });
    await user.click(within(policyGroup).getByRole('radio', { name: /^Local only/u }));
    expect(screen.getAllByText('Local · Mutating').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Build agent' }));
    await screen.findByText('Build complete');

    expect(postedDefinition(fetchMock.mock.calls).capabilities).toEqual([
      { id: 'ast-summarizer', profile: 'local-package' },
      { id: 'vision', profile: 'local-package' },
    ]);
  });

  it('blocks Local only when Azure has no local-compatible Registry profile', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (requestUrl(input).endsWith('/api/capabilities')) return jsonResponse(catalogFixture);
      throw new Error(`Unexpected request: ${requestUrl(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Developer Optimization preset/i });
    await user.click(screen.getByRole('button', { name: /Developer Optimization preset/i }));
    const policyGroup = screen.getByRole('group', { name: 'Execution policy' });
    await user.click(within(policyGroup).getByRole('radio', { name: /^Local only/u }));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Local only is incompatible');
    expect(alert.textContent).toContain('Azure Agent Tool Server');
    expect(alert.textContent).toContain('no Registry profile that can execute locally');
    expect(screen.getByRole('button', { name: 'Build agent' })).toHaveProperty('disabled', true);
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/api/build'))).toBe(
      false,
    );
  });

  it('shows Registry-driven mutation posture and sends only explicit Custom profiles', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input);
        if (url.endsWith('/api/capabilities')) return jsonResponse(catalogFixture);
        if (url.endsWith('/api/build') && init?.method === 'POST') {
          return jsonResponse(buildResultFixture);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Developer Optimization preset/i });
    await user.click(screen.getByRole('button', { name: /Developer Optimization preset/i }));
    const azureHeading = screen.getByRole('heading', { name: 'Azure Agent Tool Server' });
    const azureCard = azureHeading.closest('article');
    if (azureCard === null) throw new Error('Expected the Azure capability card.');
    const azureControls = within(azureCard);
    const readOnly = azureControls.getByRole('radio', { name: /Remote · Read-only/u });
    const mutating = azureControls.getByRole('radio', { name: /Remote · Mutating/u });
    expect(readOnly).toHaveProperty('checked', true);
    expect(mutating).toHaveProperty('checked', false);
    expect(screen.queryByText('hosted-mutating-http')).toBeNull();

    await user.click(mutating);
    await user.click(screen.getByRole('button', { name: 'Build agent' }));
    await screen.findByText('Build complete');

    expect(postedDefinition(fetchMock.mock.calls).capabilities).toEqual(
      expect.arrayContaining([
        { id: 'vision', profile: 'local-package' },
        { id: 'azure', profile: 'hosted-mutating' },
      ]),
    );
    expect(
      postedDefinition(fetchMock.mock.calls).capabilities.filter(
        (selection) => selection.profile !== undefined,
      ),
    ).toHaveLength(2);
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
    expect(screen.getAllByText('Local Agent · Mixed capabilities')).toHaveLength(2);
    expect(screen.getAllByText('Remote · Read-only').length).toBeGreaterThan(0);
    expect(screen.getByText('hosted-read-only-http')).toBeTruthy();
    expect(screen.getAllByText('Ready after environment preparation.').length).toBeGreaterThan(0);
    expect(screen.getByText('7 MCP servers configured')).toBeTruthy();
    expect(screen.getByText('.github/agents/developer-optimization.agent.md')).toBeTruthy();
    expect(screen.getByText('{"kind":"agent-lock"}')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Prepare · coming next/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('prepare'))).toBe(
      false,
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
