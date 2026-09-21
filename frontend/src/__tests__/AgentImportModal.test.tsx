import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as AppContext from '../context/AppContext';
import * as api from '../utils/api';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

import { AgentImportModal } from '../components/AgentImportModal';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    agents: [],
    setAgents: vi.fn(),
    fetchAgents: vi.fn(),
    activeAgentId: null,
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

const validAgent = {
  name: 'my-agent',
  prompt: 'You are a helpful assistant',
  kind: 'editor',
};

// Helper to get the "Import Agent" submit button (not the heading)
function getImportBtn() {
  return screen.getByRole('button', { name: 'Import Agent' });
}

describe('AgentImportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseApp();
  });

  // ─── Rendering ────────────────────────────────────────────────────────────

  it('renders the modal heading', () => {
    render(<AgentImportModal onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Import Agent' })).toBeInTheDocument();
  });

  it('renders the drag-and-drop zone', () => {
    render(<AgentImportModal onClose={() => {}} />);
    expect(screen.getByLabelText('Drop zone for JSON file')).toBeInTheDocument();
  });

  it('renders the Browse file button', () => {
    render(<AgentImportModal onClose={() => {}} />);
    expect(screen.getByText('Browse file')).toBeInTheDocument();
  });

  it('renders the textarea for pasting JSON', () => {
    render(<AgentImportModal onClose={() => {}} />);
    expect(screen.getByLabelText('Or paste JSON directly:')).toBeInTheDocument();
  });

  it('renders Cancel and Import Agent buttons', () => {
    render(<AgentImportModal onClose={() => {}} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(getImportBtn()).toBeInTheDocument();
  });

  it('Import Agent button is disabled when textarea is empty', () => {
    render(<AgentImportModal onClose={() => {}} />);
    expect(getImportBtn()).toBeDisabled();
  });

  // ─── Cancel button ─────────────────────────────────────────────────────────

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<AgentImportModal onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when clicking the backdrop', () => {
    const onClose = vi.fn();
    render(<AgentImportModal onClose={onClose} />);
    const backdrop = document.querySelector('.modal-backdrop')!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ─── Live JSON parse error (textarea typing) ──────────────────────────────

  it('shows live parse error when invalid JSON is typed', () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: '{invalid json' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toMatch(/Invalid JSON/i);
  });

  it('clears parse error when valid JSON is typed after invalid', () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: '{bad' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: JSON.stringify(validAgent) } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears parse error when textarea is cleared', () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: '{bad' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: '' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ─── Semantic validation errors on submit ─────────────────────────────────

  it('shows error on submit when name is missing', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ prompt: 'hello' }) } });
    fireEvent.click(getImportBtn());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Missing required field: name/);
    });
  });

  it('shows error on submit when name has invalid characters', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'my agent!', prompt: 'hello' }) } });
    fireEvent.click(getImportBtn());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/letters, numbers, dashes/);
    });
  });

  it('shows error on submit when prompt is missing', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'my-agent' }) } });
    fireEvent.click(getImportBtn());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Missing required field: prompt/);
    });
  });

  it('shows error on submit when prompt is empty string', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'my-agent', prompt: '   ' }) } });
    fireEvent.click(getImportBtn());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Missing required field: prompt/);
    });
  });

  it('shows error on submit when kind is invalid', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'my-agent', prompt: 'hi', kind: 'robot' }) } });
    fireEvent.click(getImportBtn());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/kind must be 'editor' or 'inspector'/);
    });
  });

  it('shows error on submit when mcpServers item is missing name', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    const payload = { name: 'my-agent', prompt: 'hi', mcpServers: [{ command: 'npx' }] };
    fireEvent.change(textarea, { target: { value: JSON.stringify(payload) } });
    fireEvent.click(getImportBtn());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/mcpServers\[0\]: each server must have a non-empty name and command/);
    });
  });

  it('shows error on submit when mcpServers item is missing command', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    const payload = { name: 'my-agent', prompt: 'hi', mcpServers: [{ name: 'my-server', command: '' }] };
    fireEvent.change(textarea, { target: { value: JSON.stringify(payload) } });
    fireEvent.click(getImportBtn());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/mcpServers\[0\]: each server must have a non-empty name and command/);
    });
  });

  it('shows mcpServers error with correct index for second failing item', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    const payload = {
      name: 'my-agent', prompt: 'hi',
      mcpServers: [
        { name: 'ok', command: 'npx' },
        { name: '', command: 'npx' },
      ],
    };
    fireEvent.change(textarea, { target: { value: JSON.stringify(payload) } });
    fireEvent.click(getImportBtn());
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/mcpServers\[1\]/);
    });
  });

  // ─── Successful import ────────────────────────────────────────────────────

  it('calls POST /api/agents with stripped payload on valid submit', async () => {
    const createdAgent = { id: 99, ...validAgent };
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => createdAgent,
    } as any);

    const setAgents = vi.fn();
    const setActiveAgentId = vi.fn();
    mockUseApp({ setAgents, setActiveAgentId });

    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    // Include server-managed fields that should be stripped
    const payload = { ...validAgent, id: 5, userId: 1, createdAt: '2024', updatedAt: '2024', tabIds: [2] };
    fireEvent.change(textarea, { target: { value: JSON.stringify(payload) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(vi.mocked(api.apiFetch)).toHaveBeenCalledWith('/api/agents', expect.objectContaining({
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
    expect(body.prompt).toBe('You are a helpful assistant');
  });

  it('adds agent to list and sets active agent on success', async () => {
    const createdAgent = { id: 99, ...validAgent };
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => createdAgent,
    } as any);

    const setAgents = vi.fn();
    const setActiveAgentId = vi.fn();
    mockUseApp({ setAgents, setActiveAgentId });

    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify(validAgent) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(setActiveAgentId).toHaveBeenCalledWith(99);
    });
    expect(setAgents).toHaveBeenCalled();
  });

  it('upserts by id on success — no duplicate when agent already added by WS echo', async () => {
    const createdAgent = { id: 99, ...validAgent };
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => createdAgent,
    } as any);

    // Capture the state updater passed to setAgents so we can apply it to a
    // prev list that ALREADY contains the created agent (simulating the WS
    // `agent-created` echo landing before the POST response resolves).
    const setAgents = vi.fn();
    const setActiveAgentId = vi.fn();
    mockUseApp({ setAgents, setActiveAgentId });

    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify(validAgent) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(setAgents).toHaveBeenCalled();
    });

    // setAgents must be called with a functional updater (not a raw array),
    // and that updater must dedup by id.
    const updater = setAgents.mock.calls[0][0];
    expect(typeof updater).toBe('function');
    const prevWithEcho = [createdAgent];
    const next = updater(prevWithEcho);
    expect(next.filter((a: any) => a.id === createdAgent.id)).toHaveLength(1);
    expect(next).toHaveLength(1);
  });

  it('calls onClose after successful import', async () => {
    const createdAgent = { id: 99, ...validAgent };
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => createdAgent,
    } as any);

    const onClose = vi.fn();
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify(validAgent) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  // ─── API error handling ───────────────────────────────────────────────────

  it('shows inline error when API returns non-ok response', async () => {
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Agent name already exists' }),
    } as any);

    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify(validAgent) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Agent name already exists/);
    });
  });

  it('does not close modal on API error', async () => {
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    } as any);

    const onClose = vi.fn();
    render(<AgentImportModal onClose={onClose} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify(validAgent) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  // ─── Drag-and-drop ────────────────────────────────────────────────────────

  it('adds drag-over class on dragover event', () => {
    render(<AgentImportModal onClose={() => {}} />);
    const dropZone = screen.getByLabelText('Drop zone for JSON file');
    fireEvent.dragOver(dropZone);
    expect(dropZone).toHaveClass('drag-over');
  });

  it('removes drag-over class on dragleave event', () => {
    render(<AgentImportModal onClose={() => {}} />);
    const dropZone = screen.getByLabelText('Drop zone for JSON file');
    fireEvent.dragOver(dropZone);
    fireEvent.dragLeave(dropZone);
    expect(dropZone).not.toHaveClass('drag-over');
  });

  it('loads file content into textarea on drop without auto-submitting', async () => {
    render(<AgentImportModal onClose={() => {}} />);
    const dropZone = screen.getByLabelText('Drop zone for JSON file');

    const fileContent = JSON.stringify(validAgent);
    const file = new File([fileContent], 'my-agent.json', { type: 'application/json' });

    // Mock FileReader
    const mockReadAsText = vi.fn();
    const mockFileReader = {
      readAsText: mockReadAsText,
      onload: null as any,
    };
    vi.spyOn(globalThis, 'FileReader').mockImplementation(() => mockFileReader as any);

    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    });

    // Simulate FileReader onload
    mockFileReader.onload({ target: { result: fileContent } });

    await waitFor(() => {
      const textarea = screen.getByLabelText('Or paste JSON directly:') as HTMLTextAreaElement;
      expect(textarea.value).toBe(fileContent);
    });

    // Should not auto-submit
    expect(vi.mocked(api.apiFetch)).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // ─── Validation: kind is valid ────────────────────────────────────────────

  it('accepts kind=editor without error', async () => {
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: 'my-agent', prompt: 'hi', kind: 'editor' }),
    } as any);

    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'my-agent', prompt: 'hi', kind: 'editor' }) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(vi.mocked(api.apiFetch)).toHaveBeenCalled();
    });
  });

  it('accepts kind=inspector without error', async () => {
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: 'my-agent', prompt: 'hi', kind: 'inspector' }),
    } as any);

    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    fireEvent.change(textarea, { target: { value: JSON.stringify({ name: 'my-agent', prompt: 'hi', kind: 'inspector' }) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(vi.mocked(api.apiFetch)).toHaveBeenCalled();
    });
  });

  it('accepts valid mcpServers array', async () => {
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: 'my-agent', prompt: 'hi' }),
    } as any);

    render(<AgentImportModal onClose={() => {}} />);
    const textarea = screen.getByLabelText('Or paste JSON directly:');
    const payload = {
      name: 'my-agent',
      prompt: 'hi',
      mcpServers: [{ name: 'server1', command: 'npx', args: [], env: [] }],
    };
    fireEvent.change(textarea, { target: { value: JSON.stringify(payload) } });
    fireEvent.click(getImportBtn());

    await waitFor(() => {
      expect(vi.mocked(api.apiFetch)).toHaveBeenCalled();
    });
  });
});
