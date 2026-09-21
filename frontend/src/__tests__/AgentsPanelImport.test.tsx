import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as AppContext from '../context/AppContext';

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

const mockAgent = {
  id: 1,
  name: 'dev-agent',
  description: 'Writes code',
  kind: 'editor' as const,
  requiresTask: true,
  claimState: 'todo',
  workingState: 'in-progress',
  resolveState: 'developed',
  tools: ['read', 'write'],
  allowedTools: ['read'],
  resources: [],
  prompt: 'Write code',
  userId: 42,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-02',
  tabIds: [2, 3],
  toolsSettings: {},
  mcpServers: [],
};

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    agents: [mockAgent],
    setAgents: vi.fn(),
    fetchAgents: vi.fn(),
    activeAgentId: 1,
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

// Helper to capture the text content of the Blob passed to URL.createObjectURL
function captureExportedJson(callback: () => void): string {
  let capturedText: string | undefined;
  const OrigBlob = globalThis.Blob;
  const blobSpy = vi.spyOn(globalThis, 'Blob').mockImplementation((parts?: BlobPart[], options?: BlobPropertyBag) => {
    if (parts && typeof parts[0] === 'string') {
      capturedText = parts[0] as string;
    }
    return new OrigBlob(parts, options);
  });
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:fake-url'), configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });

  callback();

  blobSpy.mockRestore();
  if (!capturedText) throw new Error('No blob was created during export');
  return capturedText;
}

describe('AgentsPanel — Export fix', () => {
  let mockMql: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMql = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => mockMql));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exported JSON does not contain server-managed fields: id, userId, createdAt, updatedAt, tabIds', () => {
    mockUseApp({ activeAgentId: 1 });
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    const jsonText = captureExportedJson(() => fireEvent.click(screen.getByText('Export')));
    const exported = JSON.parse(jsonText);

    expect(exported).not.toHaveProperty('id');
    expect(exported).not.toHaveProperty('userId');
    expect(exported).not.toHaveProperty('createdAt');
    expect(exported).not.toHaveProperty('updatedAt');
    expect(exported).not.toHaveProperty('tabIds');
  });

  it('exported JSON contains the importable fields: name, prompt, tools, kind', () => {
    mockUseApp({ activeAgentId: 1 });
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);

    const jsonText = captureExportedJson(() => fireEvent.click(screen.getByText('Export')));
    const exported = JSON.parse(jsonText);

    expect(exported).toHaveProperty('name', 'dev-agent');
    expect(exported).toHaveProperty('prompt', 'Write code');
    expect(exported).toHaveProperty('tools');
    expect(exported).toHaveProperty('kind', 'editor');
  });
});

describe('AgentsPanel — Import button', () => {
  let mockMql: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMql = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => mockMql));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows Import button when an agent is selected', () => {
    mockUseApp({ activeAgentId: 1 });
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);
    expect(screen.getByText('Import')).toBeInTheDocument();
  });

  it('Import button is inside .agent-controls', () => {
    mockUseApp({ activeAgentId: 1 });
    const { container } = render(<MemoryRouter><AgentsPanel /></MemoryRouter>);
    const controls = container.querySelector('.agent-controls');
    expect(controls).not.toBeNull();
    const importBtn = Array.from(controls!.querySelectorAll('button')).find(b => b.textContent === 'Import');
    expect(importBtn).toBeInTheDocument();
  });

  it('Import button does not appear when no agent is selected', () => {
    mockUseApp({ activeAgentId: null, agents: [] });
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);
    expect(screen.queryByText('Import')).not.toBeInTheDocument();
  });

  it('clicking Import opens the AgentImportModal', () => {
    mockUseApp({ activeAgentId: 1 });
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);
    fireEvent.click(screen.getByText('Import'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Import Agent' })).toBeInTheDocument();
  });

  it('closing the import modal hides it', () => {
    mockUseApp({ activeAgentId: 1 });
    render(<MemoryRouter><AgentsPanel /></MemoryRouter>);
    fireEvent.click(screen.getByText('Import'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Import button is positioned next to Export in agent-controls (Export then Import)', () => {
    mockUseApp({ activeAgentId: 1 });
    const { container } = render(<MemoryRouter><AgentsPanel /></MemoryRouter>);
    const controls = container.querySelector('.agent-controls');
    const buttons = Array.from(controls!.querySelectorAll('button')).map(b => b.textContent);
    const exportIdx = buttons.indexOf('Export');
    const importIdx = buttons.indexOf('Import');
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThanOrEqual(0);
    // Import should be right after Export
    expect(importIdx).toBe(exportIdx + 1);
  });
});
