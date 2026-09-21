import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as AppContext from '../context/AppContext';
import { AgentImportModal } from '../components/AgentImportModal';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    agents: [],
    setAgents: vi.fn(),
    fetchAgents: vi.fn(),
    activeAgentId: null,
    setActiveAgentId: vi.fn(),
    tabs: [],
    sessions: [],
    errors: [],
    activeTabId: null,
    fetchTabs: vi.fn(),
    fetchSessions: vi.fn(),
    fetchErrors: vi.fn(),
    setTabs: vi.fn(),
    setSessions: vi.fn(),
    setErrors: vi.fn(),
    setActiveTabId: vi.fn(),
  };
  vi.mocked(AppContext.useApp).mockReturnValue({ ...base, ...overrides } as any);
  return { ...base, ...overrides };
}

const validAgentJson = JSON.stringify({
  name: 'my-agent',
  prompt: 'You are a helpful agent.',
  kind: 'editor',
});

describe('AgentImportModal', () => {
  let onClose: ReturnType<typeof vi.fn>;
  let setAgents: ReturnType<typeof vi.fn>;
  let setActiveAgentId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onClose = vi.fn();
    setAgents = vi.fn();
    setActiveAgentId = vi.fn();
    mockUseApp({ setAgents, setActiveAgentId });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  it('renders the modal with a textarea, Cancel and Import Agent buttons', () => {
    render(<AgentImportModal onClose={onClose} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import agent/i })).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', () => {
    render(<AgentImportModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when clicking the backdrop', () => {
    const { container } = render(<AgentImportModal onClose={onClose} />);
    const backdrop = container.querySelector('.modal-backdrop');
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Live JSON validation (inline errors while typing)
  // -------------------------------------------------------------------------

  it('shows invalid JSON error live as the user types invalid JSON', () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'not json' } });
    expect(screen.getByText(/invalid json/i)).toBeInTheDocument();
  });

  it('clears the error when the user fixes the JSON', () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'not json' } });
    expect(screen.getByText(/invalid json/i)).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: validAgentJson } });
    expect(screen.queryByText(/invalid json/i)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Submit-time validation errors (shown inline)
  // -------------------------------------------------------------------------

  it('shows "Missing required field: name" error on submit when name is absent', async () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ prompt: 'hello' }) } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));
    expect(screen.getByText(/missing required field: name/i)).toBeInTheDocument();
  });

  it('shows name invalid chars error when name has spaces/special chars', async () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'bad name!', prompt: 'hello' }) } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));
    expect(screen.getByText(/name must only contain letters, numbers, dashes, and underscores/i)).toBeInTheDocument();
  });

  it('shows "Missing required field: prompt" error on submit when prompt is absent', async () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'my-agent' }) } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));
    expect(screen.getByText(/missing required field: prompt/i)).toBeInTheDocument();
  });

  it('shows "Missing required field: prompt" when prompt is an empty string', async () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'my-agent', prompt: '' }) } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));
    expect(screen.getByText(/missing required field: prompt/i)).toBeInTheDocument();
  });

  it('shows kind validation error when kind has an invalid value', async () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'agent', prompt: 'go', kind: 'invalid' }) } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));
    expect(screen.getByText(/kind must be 'editor' or 'inspector'/i)).toBeInTheDocument();
  });

  it('shows mcpServers validation error for a server missing name', async () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    const json = JSON.stringify({
      name: 'agent',
      prompt: 'go',
      mcpServers: [{ command: 'npx' }], // missing name
    });
    fireEvent.change(textarea, { target: { value: json } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));
    expect(screen.getByText(/mcpServers\[0\]/i)).toBeInTheDocument();
  });

  it('shows mcpServers validation error for a server missing command', async () => {
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    const json = JSON.stringify({
      name: 'agent',
      prompt: 'go',
      mcpServers: [{ name: 'srv' }], // missing command
    });
    fireEvent.change(textarea, { target: { value: json } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));
    expect(screen.getByText(/mcpServers\[0\]/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Successful import
  // -------------------------------------------------------------------------

  it('calls POST /api/agents with cleaned payload (no id/userId/etc.) on valid submit', async () => {
    const createdAgent = { id: 99, name: 'my-agent', prompt: 'You are a helpful agent.', kind: 'editor' };
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => createdAgent,
    } as Response);

    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByRole('textbox');
    // Include server-managed fields that should be stripped
    const jsonWithExtras = JSON.stringify({
      id: 1,
      userId: 42,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
      tabIds: [1, 2],
      name: 'my-agent',
      prompt: 'You are a helpful agent.',
      kind: 'editor',
    });
    fireEvent.change(textarea, { target: { value: jsonWithExtras } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));

    await waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith('/api/agents', expect.objectContaining({
        method: 'POST',
      }));
    });

    // Verify the body does NOT contain server-managed fields
    const callArgs = vi.mocked(api.apiFetch).mock.calls[0];
    const body = JSON.parse((callArgs[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('createdAt');
    expect(body).not.toHaveProperty('updatedAt');
    expect(body).not.toHaveProperty('tabIds');
    expect(body.name).toBe('my-agent');
    expect(body.prompt).toBe('You are a helpful agent.');
  });

  it('adds the new agent to the list and sets it as active on success', async () => {
    const createdAgent = { id: 99, name: 'my-agent', prompt: 'You are a helpful agent.', kind: 'editor' };
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => createdAgent,
    } as Response);

    render(<AgentImportModal onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: validAgentJson } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));

    await waitFor(() => {
      expect(setAgents).toHaveBeenCalled();
      expect(setActiveAgentId).toHaveBeenCalledWith(99);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows API error inline and does not close modal on API failure', async () => {
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Name already taken' }),
    } as Response);

    render(<AgentImportModal onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: validAgentJson } });
    fireEvent.click(screen.getByRole('button', { name: /import agent/i }));

    await waitFor(() => {
      expect(screen.getByText(/name already taken/i)).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Drag-and-drop zone
  // -------------------------------------------------------------------------

  it('renders a drop zone', () => {
    const { container } = render(<AgentImportModal onClose={onClose} />);
    expect(container.querySelector('.import-drop-zone')).toBeInTheDocument();
  });

  it('populates the textarea when a JSON file is dropped onto the drop zone', async () => {
    const { container } = render(<AgentImportModal onClose={onClose} />);
    const dropZone = container.querySelector('.import-drop-zone')!;
    const fileContent = validAgentJson;
    const file = new File([fileContent], 'agent.json', { type: 'application/json' });

    // Simulate drop
    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [file],
      },
    });

    await waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe(fileContent);
    });
  });

  it('does not auto-import when a file is dropped (only loads into textarea)', async () => {
    const { container } = render(<AgentImportModal onClose={onClose} />);
    const dropZone = container.querySelector('.import-drop-zone')!;
    const file = new File([validAgentJson], 'agent.json', { type: 'application/json' });

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    // API should NOT be called
    await waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe(validAgentJson);
    });
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AgentsPanel — Export fix: strips server-managed fields
// ---------------------------------------------------------------------------

describe('AgentsPanel export strips server-managed fields', () => {
  // We test the export logic directly by rendering AgentsPanel and clicking Export,
  // then asserting the blob content via URL.createObjectURL mock.

  let createdObjectURLArg: Blob | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    createdObjectURLArg = null;

    // Stub URL.createObjectURL to capture the blob
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        createdObjectURLArg = blob;
        return 'blob:mock-url';
      }),
      revokeObjectURL: vi.fn(),
    });

    // Stub document.createElement to capture anchor click
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'a') {
        const anchor = originalCreateElement('a');
        vi.spyOn(anchor, 'click').mockImplementation(() => {});
        return anchor;
      }
      return originalCreateElement(tagName);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exported JSON does not contain id, userId, createdAt, updatedAt, tabIds', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { AgentsPanel } = await import('../components/AgentsPanel');

    const agentWithExtras = {
      id: 5,
      userId: 1,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
      tabIds: [2],
      name: 'dev-agent',
      description: 'Does stuff',
      prompt: 'You are a dev agent.',
      tools: ['read', 'write'],
      allowedTools: [],
      resources: [],
      kind: 'editor' as const,
      requiresTask: true,
      claimState: 'todo',
      workingState: 'in-progress',
      resolveState: 'developed',
      toolsSettings: {},
      mcpServers: [],
    };

    vi.mocked(AppContext.useApp).mockReturnValue({
      agents: [agentWithExtras] as any,
      setAgents: vi.fn(),
      fetchAgents: vi.fn(),
      activeAgentId: 5,
      setActiveAgentId: vi.fn(),
    } as any);

    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    render(
      <MemoryRouter>
        <AgentsPanel />
      </MemoryRouter>
    );

    const exportBtn = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportBtn);

    // The blob should have been created
    expect(createdObjectURLArg).not.toBeNull();

    // jsdom doesn't implement Blob.text(); read via FileReader instead
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(createdObjectURLArg as Blob);
    });
    const parsed = JSON.parse(text);

    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('userId');
    expect(parsed).not.toHaveProperty('createdAt');
    expect(parsed).not.toHaveProperty('updatedAt');
    expect(parsed).not.toHaveProperty('tabIds');

    // Should still have the importable fields
    expect(parsed.name).toBe('dev-agent');
    expect(parsed.prompt).toBe('You are a dev agent.');
    expect(parsed.kind).toBe('editor');
  });
});

// ---------------------------------------------------------------------------
// AgentsPanel — Import button appears in agent controls
// ---------------------------------------------------------------------------

describe('AgentsPanel import button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.mock('../utils/api', () => ({
      apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows Import button when an agent is selected', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { AgentsPanel } = await import('../components/AgentsPanel');

    vi.mocked(AppContext.useApp).mockReturnValue({
      agents: [{ id: 1, name: 'dev-agent', prompt: 'go', kind: 'editor', requiresTask: true, claimState: 'todo', workingState: 'in-progress', resolveState: 'developed', tools: [], allowedTools: [], resources: [] }] as any,
      setAgents: vi.fn(),
      fetchAgents: vi.fn(),
      activeAgentId: 1,
      setActiveAgentId: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <AgentsPanel />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /import/i })).toBeInTheDocument();
  });

  it('does NOT show Import button when no agent is selected', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { AgentsPanel } = await import('../components/AgentsPanel');

    vi.mocked(AppContext.useApp).mockReturnValue({
      agents: [],
      setAgents: vi.fn(),
      fetchAgents: vi.fn(),
      activeAgentId: null,
      setActiveAgentId: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <AgentsPanel />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /^import$/i })).not.toBeInTheDocument();
  });

  it('clicking Import button opens the AgentImportModal', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { AgentsPanel } = await import('../components/AgentsPanel');

    vi.mocked(AppContext.useApp).mockReturnValue({
      agents: [{ id: 1, name: 'dev-agent', prompt: 'go', kind: 'editor', requiresTask: true, claimState: 'todo', workingState: 'in-progress', resolveState: 'developed', tools: [], allowedTools: [], resources: [] }] as any,
      setAgents: vi.fn(),
      fetchAgents: vi.fn(),
      activeAgentId: 1,
      setActiveAgentId: vi.fn(),
    } as any);

    render(
      <MemoryRouter>
        <AgentsPanel />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /import/i }));

    // Modal should appear — look for the Import Agent submit button
    expect(screen.getByRole('button', { name: /import agent/i })).toBeInTheDocument();
  });
});
