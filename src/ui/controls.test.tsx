/** The controls the search box and the settings panel are built from, used the way a person uses them. */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MultiSelect, Section, count } from './controls';

type Meal = 'breakfast' | 'lunch' | 'dinner';
const MEALS: [Meal, string][] = [
  ['breakfast', 'Breakfast'],
  ['lunch', 'Lunch'],
  ['dinner', 'Dinner'],
];

/** The field with its choices kept the way a page keeps them. `current()` is what is chosen now. */
function openField(initial: Meal[] = []) {
  let latest = initial;
  const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  function Holder() {
    const [chosen, setChosen] = useState(latest);
    latest = chosen;
    return (
      <form onSubmit={onSubmit}>
        <input aria-label="Before" />
        <MultiSelect label="Meals" empty="Any" choices={MEALS} chosen={chosen} onChange={setChosen} />
        <input aria-label="After" />
        <button>Send</button>
      </form>
    );
  }
  const user = userEvent.setup();
  render(<Holder />);
  return { user, onSubmit, current: () => latest };
}

const field = () => screen.getByRole('button', { name: /^Meals/ });
const choices = () => screen.queryByRole('group', { name: 'Meals' });
const box = (name: string) => screen.getByRole('checkbox', { name });

describe('a field with several choices', () => {
  it('says what is chosen, and what it was told to say while nothing is', () => {
    const { unmount } = render(<MultiSelect label="Meals" empty="Any" choices={MEALS} chosen={[]} onChange={() => {}} />);
    expect(field()).toHaveAccessibleName('Meals Any');
    unmount();

    render(<MultiSelect label="Meals" empty="Any" choices={MEALS} chosen={['dinner', 'breakfast']} onChange={() => {}} />);
    expect(field()).toHaveAccessibleName('Meals Breakfast, Dinner');
  });

  it('keeps its choices out of the way until it is pressed, then shows them ticked where chosen', async () => {
    const { user } = openField(['lunch']);
    expect(choices()).not.toBeInTheDocument();
    expect(field()).toHaveAttribute('aria-expanded', 'false');

    await user.click(field());

    expect(field()).toHaveAttribute('aria-expanded', 'true');
    expect(within(choices()!).getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([false, true, false]);

    await user.click(field());
    expect(choices()).not.toBeInTheDocument();
  });

  it('gives the choices in the order of the list, whatever order they were ticked in', async () => {
    const { user, current } = openField();
    await user.click(field());

    await user.click(box('Dinner'));
    expect(current()).toEqual(['dinner']);
    await user.click(box('Breakfast'));
    expect(current()).toEqual(['breakfast', 'dinner']);
    expect(field()).toHaveAccessibleName('Meals Breakfast, Dinner');
    // The list stays open, so several can be ticked in one go.
    expect(choices()).toBeInTheDocument();

    await user.click(box('Dinner'));
    expect(current()).toEqual(['breakfast']);
  });

  it('closes with Escape and hands the focus back, and with a press anywhere else', async () => {
    const { user } = openField();
    await user.click(field());
    await user.click(box('Lunch'));
    await user.keyboard('{Escape}');
    expect(choices()).not.toBeInTheDocument();
    expect(field()).toHaveFocus();

    await user.click(field());
    await user.click(screen.getByLabelText('After'));
    expect(choices()).not.toBeInTheDocument();
  });

  it('can be used with the keyboard alone, and closes once the focus moves on', async () => {
    const { user, current } = openField();
    await user.click(screen.getByLabelText('Before'));
    await user.tab();
    expect(field()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(choices()).toBeInTheDocument();

    await user.tab();
    expect(box('Breakfast')).toHaveFocus();
    await user.keyboard(' ');
    await user.tab();
    await user.tab();
    expect(box('Dinner')).toHaveFocus();
    await user.keyboard(' ');
    expect(current()).toEqual(['breakfast', 'dinner']);

    await user.tab();
    expect(screen.getByLabelText('After')).toHaveFocus();
    expect(choices()).not.toBeInTheDocument();
  });

  it('never sends the form around it: not when it is pressed, and not when Enter ticks a choice', async () => {
    const { user, onSubmit, current } = openField();
    await user.click(field());
    await user.tab();
    await user.keyboard('{Enter}');
    expect(current()).toEqual(['breakfast']);
    await user.keyboard('{Enter}');
    expect(current()).toEqual([]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes on Escape without closing whatever it sits in', async () => {
    // The settings panel closes on Escape too. A list open inside a panel must take the key for itself.
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      const { user } = openField();
      await user.click(field());
      await user.keyboard('{Escape}');
      expect(choices()).not.toBeInTheDocument();
      expect(behind).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });
});

describe('a section that folds away', () => {
  function openSection(startsOpen: boolean) {
    function Holder() {
      const [open, setOpen] = useState(startsOpen);
      return (
        <Section title="Job boards" badge="Experimental" summary="2 of 14 selected" open={open} onToggle={() => setOpen(!open)}>
          <p>What is inside</p>
        </Section>
      );
    }
    const user = userEvent.setup();
    render(<Holder />);
    return { user };
  }
  const heading = () => screen.getByRole('button', { name: /^Job boards/ });

  it('says what is chosen inside while it is folded', () => {
    openSection(false);
    expect(screen.getByRole('heading', { level: 3 })).toContainElement(heading());
    expect(heading()).toHaveAccessibleName('Job boards Experimental 2 of 14 selected');
    expect(heading()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('What is inside')).not.toBeInTheDocument();
  });

  it('unfolds and folds from its heading, which keeps saying what is chosen', async () => {
    const { user } = openSection(false);
    await user.click(heading());
    expect(heading()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('What is inside')).toBeInTheDocument();
    expect(heading()).toHaveTextContent('2 of 14 selected');

    await user.click(heading());
    expect(screen.queryByText('What is inside')).not.toBeInTheDocument();
  });

  it('marks a summary that is a warning or a fault, so it is seen while folded', () => {
    render(
      <Section title="Search server" summary="Not set" tone="warn" open={false} onToggle={() => {}}>
        <p>Inside</p>
      </Section>,
    );
    expect(screen.getByText('Not set')).toHaveClass('warn');
  });
});

describe('counting things in words', () => {
  it('says one of a thing and several of it', () => {
    expect([0, 1, 2].map((n) => count(n, 'job'))).toEqual(['0 jobs', '1 job', '2 jobs']);
    expect([1, 3].map((n) => count(n, 'company', 'companies'))).toEqual(['1 company', '3 companies']);
  });
});
