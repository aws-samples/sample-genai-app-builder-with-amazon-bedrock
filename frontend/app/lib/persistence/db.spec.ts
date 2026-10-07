import { describe, it, expect, vi } from 'vitest';

/**
 * Project ids used to be a per-browser counter, so every user's first project was
 * "1". Once projects became server-backed and shareable that collided: two users'
 * "project 1" are the same DynamoDB partition, and an invite carrying a numeric id
 * resolved against the guest's own project of that number — so an invited
 * collaborator saw their own conversation beside the shared files instead of the
 * owner's. These tests pin the property that fixes it: a new id is globally unique
 * and not a small integer that could collide across browsers.
 */
vi.mock('~/lib/api/projects-client', () => ({
  getProjectsClient: () => ({}),
}));

describe('getNextId', () => {
  it('is not a sequential integer that would collide across browsers', async () => {
    const { getNextId } = await import('./db');

    const id = await getNextId();

    // The old counter produced "1", "2", … — the very thing that collided.
    expect(id).not.toMatch(/^\d+$/);
    expect(id.length).toBeGreaterThan(8);
  });

  it('returns a different id every time, so two browsers never share one', async () => {
    const { getNextId } = await import('./db');

    const ids = await Promise.all(Array.from({ length: 100 }, () => getNextId()));

    expect(new Set(ids).size).toBe(ids.length);
  });
});
