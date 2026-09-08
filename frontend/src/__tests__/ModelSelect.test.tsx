import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ModelSelect } from '../components/ModelSelect';

// Mock apiFetch so the component's on-mount /api/models fetch is controllable.
vi.mock('../utils/api', () => ({
  apiFetch: vi.fn(),
}));

// antd's Select uses CSS selectors that jsdom (nwsapi) doesn't support,
// causing SyntaxError crashes in tests. We replace it with a lightweight
// functional stub that exposes the same props the component relies on.
vi.mock('antd', () => {
  const React = require('react');

  /**
   * Stub for antd Select. Renders a <select> plus a hidden loading indicator
   * so tests can inspect all relevant state and behaviour without hitting
   * jsdom's CSS parser limitations.
   */
  const Select = ({
    id,
    value,
    onChange,
    options = [],
    filterOption,
    loading,
    placeholder,
    showSearch,
    style,
    autoClearSearchValue,
  }: {
    id?: string;
    value?: string;
    onChange?: (v: string) => void;
    options?: Array<{ value: string; label: string; disabled?: boolean }>;
    filterOption?: (input: string, option?: { value: string; label: string }) => boolean;
    loading?: boolean;
    placeholder?: string;
    showSearch?: boolean;
    style?: React.CSSProperties;
    autoClearSearchValue?: boolean;
  }) => {
    const [search, setSearch] = React.useState('');

    // Determine visible options: if there's search text, apply filterOption.
    const visibleOptions = search
      ? options.filter((opt) =>
          filterOption ? filterOption(search, opt) : true
        )
      : options;

    return React.createElement(
      'div',
      { 'data-testid': 'antd-select', style },
      // Loading indicator
      loading
        ? React.createElement('span', {
            className: 'ant-select-loading',
            'aria-label': 'loading',
          })
        : null,
      // Search input (always rendered when showSearch=true)
      showSearch
        ? React.createElement('input', {
            className: 'ant-select-selection-search-input',
            'aria-label': 'search',
            value: search,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
              setSearch(e.target.value),
          })
        : null,
      // Selected-value display (mirrors .ant-select-selection-item)
      React.createElement(
        'span',
        { className: 'ant-select-selection-item' },
        options.find((o) => o.value === value)?.label ?? value ?? placeholder ?? ''
      ),
      // The native <select> drives actual value/onChange
      React.createElement(
        'select',
        {
          id,
          value: value ?? '',
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
            if (onChange) onChange(e.target.value);
            setSearch('');
          },
          'aria-label': placeholder ?? 'model',
        },
        visibleOptions.map((opt) =>
          React.createElement(
            'option',
            { key: opt.value, value: opt.value, title: opt.label, disabled: opt.disabled },
            opt.label
          )
        )
      )
    );
  };

  return { Select };
});

import { apiFetch } from '../utils/api';

function mockModels(models: Array<{ id: string; name: string; description?: string | null }>) {
  (apiFetch as any).mockResolvedValue({
    ok: true,
    json: async () => ({ default: 'auto', models }),
  });
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

  it('renders with "Auto (default)" selectable and defaults to the Auto (empty-value) state when value=""', async () => {
    const { container } = render(<ModelSelect value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    // "Auto (default)" should appear as a <select> option
    const options = Array.from(container.querySelectorAll('option'));
    const autoOption = options.find((o) => o.value === '');
    expect(autoOption).toBeTruthy();
    expect(autoOption?.textContent).toMatch(/Auto \(default\)/i);

    // The selection-item display should show Auto
    const selectionItem = container.querySelector('.ant-select-selection-item');
    expect(selectionItem?.textContent).toMatch(/Auto \(default\)/i);
  });

  it('after the mocked fetch resolves, detected model ids appear as options and can be selected, firing onChange with the model id', async () => {
    mockModels([
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet', description: null },
      { id: 'claude-opus-4.5', name: 'Claude Opus', description: null },
    ]);

    const onChange = vi.fn();
    const { container } = render(<ModelSelect value="" onChange={onChange} />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    // Both model ids should appear as options (label = id per spec)
    const options = Array.from(container.querySelectorAll('option'));
    const sonnet = options.find((o) => o.value === 'claude-sonnet-4.6');
    const opus = options.find((o) => o.value === 'claude-opus-4.5');
    expect(sonnet).toBeTruthy();
    expect(opus).toBeTruthy();
    // Label is the id, not name
    expect(sonnet?.title).toBe('claude-sonnet-4.6');
    expect(opus?.title).toBe('claude-opus-4.5');

    // Selecting fires onChange with the model id
    const select = container.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'claude-sonnet-4.6' } });
    expect(onChange).toHaveBeenCalledWith('claude-sonnet-4.6');
  });

  it('typing filters the option list by id (case-insensitive)', async () => {
    mockModels([
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet', description: null },
      { id: 'claude-opus-4.5', name: 'Claude Opus', description: null },
      { id: 'gpt-4o', name: 'GPT-4o', description: null },
    ]);

    const { container } = render(<ModelSelect value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    // Type to filter
    const searchInput = container.querySelector('.ant-select-selection-search-input')!;
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'SONNET' } });
    });

    const options = Array.from(container.querySelectorAll('option'));
    const values = options.map((o) => o.value);
    expect(values).toContain('claude-sonnet-4.6');
    // "Auto (default)" is always shown (filterOption returns true for value='')
    expect(values).toContain('');
    expect(values).not.toContain('claude-opus-4.5');
    expect(values).not.toContain('gpt-4o');
  });

  it('when value is an id not present in the fetched list, shows that value with "(not detected)" affordance', async () => {
    mockModels([
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet', description: null },
    ]);

    const { container } = render(
      <ModelSelect value="some-old-model" onChange={vi.fn()} />
    );

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    // The selection-item display should contain the value and "(not detected)"
    await waitFor(() => {
      const selectionItem = container.querySelector('.ant-select-selection-item');
      expect(selectionItem?.textContent).toContain('some-old-model');
      expect(selectionItem?.textContent).toContain('(not detected)');
    });

    // Per Requirement 6, the synthetic "(not detected)" entry is present only
    // as a display affordance — it must be disabled so users cannot select it
    // as a normal option from the dropdown.
    const options = Array.from(container.querySelectorAll('option'));
    const unknownOpt = options.find((o) => o.value === 'some-old-model');
    expect(unknownOpt).toBeTruthy();
    expect(unknownOpt?.title).toContain('(not detected)');
    expect(unknownOpt?.disabled).toBe(true);
  });

  it('on fetch failure, only "Auto (default)" is offered', async () => {
    (apiFetch as any).mockRejectedValue(new Error('network error'));

    const { container } = render(<ModelSelect value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    // Wait for loading to finish
    await waitFor(() => {
      expect(container.querySelector('.ant-select-loading')).not.toBeInTheDocument();
    });

    const options = Array.from(container.querySelectorAll('option'));
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('');
    expect(options[0].textContent).toMatch(/Auto \(default\)/i);
  });

  it('on empty models response, only "Auto (default)" is offered', async () => {
    mockModels([]);

    const { container } = render(<ModelSelect value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    await waitFor(() => {
      expect(container.querySelector('.ant-select-loading')).not.toBeInTheDocument();
    });

    const options = Array.from(container.querySelectorAll('option'));
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('');
  });

  it('passes through the id prop to the underlying select', async () => {
    const { container } = render(<ModelSelect id="sessionModel" value="" onChange={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const select = container.querySelector('#sessionModel');
    expect(select).toBeInTheDocument();
  });

  it('shows loading state while /api/models is in flight', async () => {
    let resolveModels!: (v: any) => void;
    (apiFetch as any).mockReturnValue(
      new Promise((resolve) => { resolveModels = resolve; })
    );

    const { container } = render(<ModelSelect value="" onChange={vi.fn()} />);

    // Should show loading indicator while pending
    await waitFor(() => {
      expect(container.querySelector('.ant-select-loading')).toBeInTheDocument();
    });

    // Resolve the fetch
    await act(async () => {
      resolveModels({ ok: true, json: async () => ({ default: 'auto', models: [] }) });
    });

    // Loading should be gone
    await waitFor(() => {
      expect(container.querySelector('.ant-select-loading')).not.toBeInTheDocument();
    });
  });

  it('does not show "(not detected)" for a known model while the fetch is still loading', async () => {
    // This test guards against the UX regression where a model that *will*
    // appear in the fetched list is briefly labelled "(not detected)" during
    // the loading phase (because models=[] evaluates valueIsKnown=false).
    let resolveModels!: (v: any) => void;
    (apiFetch as any).mockReturnValue(
      new Promise((resolve) => { resolveModels = resolve; })
    );

    const { container } = render(
      <ModelSelect value="claude-sonnet-4.6" onChange={vi.fn()} />
    );

    // While the fetch is pending, the loading indicator must be present…
    expect(container.querySelector('.ant-select-loading')).toBeInTheDocument();

    // …and the "(not detected)" label must NOT appear (no flash for known models).
    const selectionItem = container.querySelector('.ant-select-selection-item');
    expect(selectionItem?.textContent).not.toContain('(not detected)');

    // Resolve the fetch with the model present in the list
    await act(async () => {
      resolveModels({
        ok: true,
        json: async () => ({
          default: 'auto',
          models: [{ id: 'claude-sonnet-4.6', name: 'Claude Sonnet', description: null }],
        }),
      });
    });

    // After loading, value is confirmed known — still no "(not detected)"
    await waitFor(() => {
      expect(container.querySelector('.ant-select-loading')).not.toBeInTheDocument();
    });
    expect(container.querySelector('.ant-select-selection-item')?.textContent).not.toContain('(not detected)');
  });
});
