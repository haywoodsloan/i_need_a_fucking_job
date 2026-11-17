/** The two small hooks every page leans on: a value that is kept between visits, and the page named in the address. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRoute, useStored } from './hooks';

describe('a value kept between visits', () => {
  it('starts as the default, and is stored from then on', () => {
    const { result } = renderHook(() => useStored('last-query:v1', { role: '' }));
    expect(result.current[0]).toEqual({ role: '' });

    act(() => result.current[1]({ role: 'pilot' }));

    expect(result.current[0]).toEqual({ role: 'pilot' });
    expect(JSON.parse(localStorage.getItem('last-query:v1')!)).toEqual({ role: 'pilot' });
  });

  it('starts as what an earlier visit stored', () => {
    localStorage.setItem('last-query:v1', JSON.stringify({ role: 'nurse' }));
    const { result } = renderHook(() => useStored('last-query:v1', { role: '' }));
    expect(result.current[0]).toEqual({ role: 'nurse' });
  });

  it('is kept apart under each name', () => {
    const a = renderHook(() => useStored('a', 1));
    const b = renderHook(() => useStored('b', 2));
    act(() => a.result.current[1](10));
    expect(b.result.current[0]).toBe(2);
    expect(localStorage.getItem('a')).toBe('10');
    expect(localStorage.getItem('b')).toBe('2');
  });
});

describe('the page named in the address', () => {
  it.each([
    ['', ''],
    ['#/', ''],
    ['#/resume', 'resume'],
    ['#resume', 'resume'],
    ['#/invite/ABCD-1234', 'invite/ABCD-1234'],
    ['#/account?tab=sessions', 'account'],
  ])('for %j is %j', (hash, route) => {
    window.location.hash = hash;
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toBe(route);
  });

  it('follows the address when it changes, as it does with the back button', async () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toBe('');
    window.location.hash = '#/resume';
    await waitFor(() => expect(result.current[0]).toBe('resume'));
  });

  it('changes the address when the app goes to another page, and clears it for the first page', async () => {
    const { result } = renderHook(() => useRoute());
    act(() => result.current[1]('account'));
    expect(window.location.hash).toBe('#/account');
    await waitFor(() => expect(result.current[0]).toBe('account'));

    act(() => result.current[1](''));
    expect(window.location.hash).toBe('');
    await waitFor(() => expect(result.current[0]).toBe(''));
  });

  it('stops listening when the page that used it is gone', async () => {
    const { result, unmount } = renderHook(() => useRoute());
    unmount();
    window.location.hash = '#/resume';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current[0]).toBe('');
  });
});
