import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelCombobox } from '../components/ModelCombobox';

describe('ModelCombobox', () => {
  it('renders the current value\'s display name in the input', () => {
    render(<ModelCombobox value="claude-sonnet-4" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('Claude Sonnet 4');
  });

  it('defaults to "Auto (default)" when value is empty', () => {
    render(<ModelCombobox value="" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('Auto (default)');
  });

  it('filters the dropdown list by substring match against id and name as the user types', () => {
    render(<ModelCombobox value="" onChange={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'sonnet' } });

    expect(screen.getByText('Claude Sonnet 5')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4.5')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.6 Sol')).not.toBeInTheDocument();
  });

  it('selects an option and calls onChange when clicking a matching entry', () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'opus 5' } });

    fireEvent.mouseDown(screen.getByText('Claude Opus 5'));

    expect(onChange).toHaveBeenCalledWith('claude-opus-5');
  });

  it('selects a highlighted option on Enter', () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'qwen' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('qwen3-coder-next');
  });

  it('reverts to the last valid selection when blurred with non-matching text', () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="claude-sonnet-4" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'not-a-real-model-xyz' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('Claude Sonnet 4');
  });

  it('reverts to "auto" when blurred with non-matching text and no prior value', () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'garbage' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('Auto (default)');
  });

  it('matching by id also commits the value on blur', () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'minimax-m2.1' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith('minimax-m2.1');
  });
});
