import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({}),
  };
});

import { AgentsPanel } from '../components/AgentsPanel';

const testAgent = {
  id: 42,
  name: 'test-agent',
  description: 'A test agent',
  prompt: 'Do stuff',
  tools: ['read', 'write'],
  allowedTools: ['read'],
  resources: ['file://src/**'],
  toolsSettings: {},
  mcpServers: [],
  kind: 'editor' as const,
  requiresTask: true,
  claimState: 'todo',
  workingState: 'in-progress',
  resolveState: 'developed',
};

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    agents: [testAgent],
    setAgents: vi.fn(),
    fetchAgents: vi.fn(),
    activeAgentId: 42,
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('AgentsPanel — Import button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it('renders an "Import" button when an agent is selected', () => {
    mockUseApp();
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    expect(screen.getByRole('button', { name: /import/i })).toBeInTheDocument();
  });

  it('does not render an "Import" button when no agent is selected', () => {
    mockUseApp({ activeAgentId: null, agents: [] });
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    // Import button should not be present in empty state
    expect(screen.queryByRole('button', { name: /^import$/i })).not.toBeInTheDocument();
  });

  it('opens the import modal when Import button is clicked', () => {
    mockUseApp();
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /import/i }));

    // The import modal should be visible
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the import modal when Cancel is clicked', () => {
    mockUseApp();
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    // Open modal
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Close modal
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('AgentsPanel — Export strips server-managed fields', () => {
  let revokeObjectURLSpy: ReturnType<typeof vi.fn>;
  let capturedBlobContent: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    revokeObjectURLSpy = vi.fn();
    capturedBlobContent = null;

    // Intercept Blob constructor to capture the string content
    const OriginalBlob = globalThis.Blob;
    vi.stubGlobal('Blob', class extends OriginalBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        // Capture the first string part (the JSON string)
        if (Array.isArray(parts) && typeof parts[0] === 'string') {
          capturedBlobContent = parts[0];
        }
      }
    });

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('blob:test-url'),
      revokeObjectURL: revokeObjectURLSpy,
    });

    // Mock document.createElement to intercept the anchor click
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') {
        const anchor = originalCreateElement('a');
        anchor.click = vi.fn();
        return anchor;
      }
      return originalCreateElement(tag);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    capturedBlobContent = null;
  });

  it('exported JSON does not contain id, userId, createdAt, updatedAt, or tabIds', () => {
    // Agent with server-managed fields
    const agentWithServerFields = {
      ...testAgent,
      userId: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      tabIds: [2, 3],
    };
    mockUseApp({ agents: [agentWithServerFields as any], activeAgentId: 42 });
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    // Click the Export button
    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    expect(capturedBlobContent).not.toBeNull();
    const exported = JSON.parse(capturedBlobContent!);

    expect(exported).not.toHaveProperty('id');
    expect(exported).not.toHaveProperty('userId');
    expect(exported).not.toHaveProperty('createdAt');
    expect(exported).not.toHaveProperty('updatedAt');
    expect(exported).not.toHaveProperty('tabIds');
  });

  it('exported JSON contains importable fields like name, prompt, kind', () => {
    mockUseApp();
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    expect(capturedBlobContent).not.toBeNull();
    const exported = JSON.parse(capturedBlobContent!);

    expect(exported.name).toBe('test-agent');
    expect(exported.prompt).toBe('Do stuff');
    expect(exported.kind).toBe('editor');
  });

  it('exported JSON contains all importable fields', () => {
    mockUseApp();
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    expect(capturedBlobContent).not.toBeNull();
    const exported = JSON.parse(capturedBlobContent!);

    // Should contain all importable fields
    expect(exported).toHaveProperty('name');
    expect(exported).toHaveProperty('prompt');
    expect(exported).toHaveProperty('tools');
    expect(exported).toHaveProperty('allowedTools');
    expect(exported).toHaveProperty('resources');
    expect(exported).toHaveProperty('kind');
    expect(exported).toHaveProperty('requiresTask');
    expect(exported).toHaveProperty('claimState');
    expect(exported).toHaveProperty('workingState');
    expect(exported).toHaveProperty('resolveState');
  });
});
