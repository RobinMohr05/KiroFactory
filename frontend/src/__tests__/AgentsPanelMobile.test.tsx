import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as AppContext from '../context/AppContext';

vi.mock('../context/AppContext', () => ({
  useApp: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

import { AgentsPanel } from '../components/AgentsPanel';

function mockUseApp(overrides: Partial<ReturnType<typeof AppContext.useApp>> = {}) {
  const base = {
    agents: [
      { id: 1, name: 'Developer Agent', description: 'Writes code', kind: 'editor', requiresTask: true, claimState: 'todo', workingState: 'in-progress', resolveState: 'developed', tools: [], allowedTools: [], resources: [], prompt: 'Write code' },
      { id: 2, name: 'Reviewer Agent', description: 'Reviews code', kind: 'inspector', requiresTask: true, claimState: 'developed', workingState: 'in-code-review', resolveState: 'reviewed', tools: [], allowedTools: [], resources: [], prompt: 'Review code' },
    ],
    setAgents: vi.fn(),
    fetchAgents: vi.fn(),
    activeAgentId: null,
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
  vi.mocked(AppContext.useApp).mockReturnValue(base as any);
  return base;
}

describe('AgentsPanel - Mobile drill-down (≤480px)', () => {
  let mockMql: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMql = {
      matches: true, // mobile viewport (≤480px)
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mockMql));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('on mobile, shows only the agent list (detail panel is hidden)', () => {
    mockUseApp({ activeAgentId: 1 });
    const { container } = render(<AgentsPanel />);

    // The list panel should be visible
    const listPanel = container.querySelector('.agent-list-panel');
    expect(listPanel).not.toHaveClass('mobile-hidden');

    // The detail panel should be hidden on mobile when no item is drilled into
    const detailPanel = container.querySelector('.agent-detail-panel');
    expect(detailPanel).toHaveClass('mobile-hidden');
  });

  it('on mobile, tapping an agent item shows the detail view', () => {
    const mockSetActiveAgentId = vi.fn();
    mockUseApp({ activeAgentId: null, setActiveAgentId: mockSetActiveAgentId });
    render(<AgentsPanel />);

    // Click on an agent item
    fireEvent.click(screen.getByText('Developer Agent'));

    // setActiveAgentId should be called
    expect(mockSetActiveAgentId).toHaveBeenCalledWith(1);
  });

  it('on mobile, when drilled into detail, list panel is hidden and detail is visible', () => {
    mockUseApp({ activeAgentId: 1 });
    const { container } = render(<AgentsPanel />);

    // Simulate tapping into an agent on mobile
    const listPanel = container.querySelector('.agent-list-panel');
    const listItem = listPanel!.querySelector('.agent-item');
    fireEvent.click(listItem!);

    // After drilling in, list should be hidden and detail should be visible
    expect(listPanel).toHaveClass('mobile-hidden');

    const detailPanel = container.querySelector('.agent-detail-panel');
    expect(detailPanel).not.toHaveClass('mobile-hidden');
  });

  it('on mobile detail view, shows a back button', () => {
    mockUseApp({ activeAgentId: 1 });
    const { container } = render(<AgentsPanel />);

    // Drill into the agent
    const listPanel = container.querySelector('.agent-list-panel');
    const listItem = listPanel!.querySelector('.agent-item');
    fireEvent.click(listItem!);

    // Should show a back button
    const backBtn = container.querySelector('.mobile-back-btn');
    expect(backBtn).toBeInTheDocument();
  });

  it('on mobile, tapping the back button returns to the list view', () => {
    mockUseApp({ activeAgentId: 1 });
    const { container } = render(<AgentsPanel />);

    // Drill into the agent
    const listPanel = container.querySelector('.agent-list-panel');
    const listItem = listPanel!.querySelector('.agent-item');
    fireEvent.click(listItem!);

    // Click the back button
    const backBtn = container.querySelector('.mobile-back-btn');
    fireEvent.click(backBtn!);

    // List should be visible again, detail should be hidden
    expect(listPanel).not.toHaveClass('mobile-hidden');

    const detailPanel = container.querySelector('.agent-detail-panel');
    expect(detailPanel).toHaveClass('mobile-hidden');
  });

  it('at >480px (desktop), both list and detail are always visible (no drill-down)', () => {
    // Set desktop viewport
    mockMql.matches = false;
    mockUseApp({ activeAgentId: 1 });
    const { container } = render(<AgentsPanel />);

    // Both panels should be visible (no mobile-hidden class)
    const listPanel = container.querySelector('.agent-list-panel');
    expect(listPanel).not.toHaveClass('mobile-hidden');

    const detailPanel = container.querySelector('.agent-detail-panel');
    expect(detailPanel).not.toHaveClass('mobile-hidden');
  });

  it('on mobile, the back button is not rendered at desktop width', () => {
    mockMql.matches = false;
    mockUseApp({ activeAgentId: 1 });
    const { container } = render(<AgentsPanel />);

    expect(container.querySelector('.mobile-back-btn')).not.toBeInTheDocument();
  });
});
