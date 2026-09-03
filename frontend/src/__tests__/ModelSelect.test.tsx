import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelSelect } from '../components/ModelSelect';

// Mock apiFetch so the component's on-mount /api/models fetch is controllable.
vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../utils/api';

function mockModels(models: Array<{ id: string; name: string; description?: string | null }>) {
  (apiFetch as any).mockResolvedValue({
    ok: true,
    json: async () => ({ default: 'auto', models }),
  });
}

/** All <option> elements from the component's datalist. */
function datalistOptions(container: HTMLElement): HTMLOptionElement[] {
  return Array.from(container.querySelectorAll('datalist option'));
}

describe('ModelSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModels([]);
  });

  it('fetches /api/models on mount', async () => {
    render(<ModelSelect value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/models'));
  });

  it('shows "Auto (default)" as the first option whose value is empty', async () => {
    const { container } = render(<ModelSelect value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const options = datalistOptions(container);
    expect(options[0].value).toBe('');
    expect(options[0].textContent).toMatch(/Auto \(default\)/i);
  });

  it('renders each detected model with name as label and description as title', async () => {
    mockModels([
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: 'Balanced model' },
      { id: 'claude-opus-5', name: 'Claude Opus 5', description: null },
    ]);
    const { container } = render(<ModelSelect value="" onChange={vi.fn()} />);

    await waitFor(() => expect(datalistOptions(container).length).toBe(3));
    const options = datalistOptions(container);

    const sonnet = options.find((o) => o.value === 'claude-sonnet-4')!;
    expect(sonnet).toBeTruthy();
    expect(sonnet.label).toBe('Claude Sonnet 4');
    expect(sonnet.title).toBe('Balanced model');

    const opus = options.find((o) => o.value === 'claude-opus-5')!;
    expect(opus).toBeTruthy();
    expect(opus.label).toBe('Claude Opus 5');
    // No description -> no title.
    expect(opus.title).toBe('');
  });

  it('calls onChange with the typed value (free-typed values are accepted)', async () => {
    const onChange = vi.fn();
    render(<ModelSelect value="" onChange={onChange} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'some-undetected-model' } });
    expect(onChange).toHaveBeenCalledWith('some-undetected-model');
  });

  it('reflects the current value in the input', async () => {
    render(<ModelSelect value="claude-opus-5" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.getByRole('combobox')).toHaveValue('claude-opus-5');
  });

  it('stays usable with only the Auto option when the fetch fails', async () => {
    (apiFetch as any).mockRejectedValue(new Error('network'));
    const onChange = vi.fn();
    const { container } = render(<ModelSelect value="" onChange={onChange} />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const options = datalistOptions(container);
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('');

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'typed-anyway' } });
    expect(onChange).toHaveBeenCalledWith('typed-anyway');
  });

  it('renders only the Auto option when the response is not ok', async () => {
    (apiFetch as any).mockResolvedValue({ ok: false, json: async () => ({}) });
    const { container } = render(<ModelSelect value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const options = datalistOptions(container);
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('');
  });

  it('passes through the id prop to the input', async () => {
    render(<ModelSelect id="sessionModel" value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.getByRole('combobox')).toHaveAttribute('id', 'sessionModel');
  });
});
