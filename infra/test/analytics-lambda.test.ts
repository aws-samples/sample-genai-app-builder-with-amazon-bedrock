/**
 * Unit tests for the analytics API lambda.
 *
 * The lambda joins three signals per user and segments them:
 *   - presence  : raw authorizer pings (its EMF `"UserLogin":1` line) — fires
 *                 on every authorized API call, so it over-counts real usage.
 *   - sessions  : pings collapsed into 30-minute windows (≈ real visits).
 *   - interactions : ChatRequest / EnhancerRequest (real actions).
 *   - websites  : WebsiteCreated (real value delivered).
 *
 * These tests drive the handler with representative CloudWatch Logs Insights
 * rows and assert the join, the Presence/Active/Builder segmentation, the
 * headline rollups, and the real-user filtering.
 */

// The lambda issues, in order per log group:
//   authorizer: [presence, sessions, weeklySessions, dailyActivity, hourlyPattern]
//   streaming:  [interactions, websites, weeklyWebsites]
// StartQuery is stubbed to hand back a queryId that encodes which query it was,
// then GetQueryResults returns the matching canned rows.
const queryScripts: Record<string, Array<Record<string, string>>> = {};
let queryCounter = 0;

const mockLogsSend = jest.fn();
const mockCwSend = jest.fn();

jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: jest.fn(() => ({ send: mockLogsSend })),
  StartQueryCommand: jest.fn((input: any) => ({ _type: 'StartQuery', input })),
  GetQueryResultsCommand: jest.fn((input: any) => ({ _type: 'GetQueryResults', input })),
}));

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCwSend })),
  GetMetricStatisticsCommand: jest.fn((input: any) => ({ _type: 'GetMetricStatistics', input })),
}));

// Map each StartQuery to a script key by inspecting its queryString, so tests
// stay robust to ordering changes in Promise.all.
function classifyQuery(q: string): string {
  if (q.includes('"UserLogin":1')) {
    if (q.includes('datefloor(sessionWindow, 1w)')) return 'weeklySessions';
    if (q.includes('datefloor(sessionWindow, 1d)')) return 'dailyActivity';
    if (q.includes('bin(1h)')) return 'hourly';
    if (q.includes('sessionWindow') && q.includes('stats count(*) as sessions by userId')) return 'sessions';
    return 'presence';
  }
  if (q.includes('by model')) return 'modelUsage';
  if (q.includes('ChatRequest') || q.includes('EnhancerRequest')) return 'interactions';
  if (q.includes('WebsiteCreated')) {
    if (q.includes('datefloor(@timestamp, 1w)')) return 'weeklyWebsites';
    return 'websites';
  }
  return 'unknown';
}

const queryIdToKey: Record<string, string> = {};

beforeEach(() => {
  queryCounter = 0;
  for (const k of Object.keys(queryIdToKey)) delete queryIdToKey[k];

  mockLogsSend.mockImplementation((cmd: any) => {
    if (cmd._type === 'StartQuery') {
      const key = classifyQuery(cmd.input.queryString);
      const id = `q-${key}-${queryCounter++}`;
      queryIdToKey[id] = key;
      return Promise.resolve({ queryId: id });
    }
    if (cmd._type === 'GetQueryResults') {
      const key = queryIdToKey[cmd.input.queryId] || 'unknown';
      const rows = queryScripts[key] || [];
      const results = rows.map((row) =>
        Object.entries(row).map(([field, value]) => ({ field, value })),
      );
      return Promise.resolve({ status: 'Complete', results });
    }
    return Promise.resolve({});
  });

  mockCwSend.mockResolvedValue({ Datapoints: [] });
});

afterEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(queryScripts)) delete queryScripts[k];
});

import { handler } from '../lambda/analytics/index';

async function invoke() {
  const res = await handler({} as any);
  return JSON.parse(res.body);
}

describe('analytics lambda — metric separation', () => {
  test('segments users into builder / active / presence and joins per-user signals', async () => {
    queryScripts.presence = [
      { userId: 'builder1', firstSeen: '1000', lastSeen: '2000', pings: '500' },
      { userId: 'active1', firstSeen: '1000', lastSeen: '2000', pings: '120' },
      { userId: 'lurker1', firstSeen: '1000', lastSeen: '2000', pings: '900' },
    ];
    queryScripts.sessions = [
      { userId: 'builder1', sessions: '12' },
      { userId: 'active1', sessions: '4' },
      { userId: 'lurker1', sessions: '30' },
    ];
    queryScripts.interactions = [
      { userId: 'builder1', chatRequests: '40', enhancerRequests: '5', interactionEvents: '45' },
      { userId: 'active1', chatRequests: '8', enhancerRequests: '0', interactionEvents: '8' },
    ];
    queryScripts.websites = [
      { userId: 'builder1', websites: '7', inputTokens: '1000', outputTokens: '2000', genEvents: '7' },
    ];

    const data = await invoke();

    // builder1 generated a website -> builder; active1 interacted but no site ->
    // active; lurker1 only pinged -> presence.
    const byId = Object.fromEntries(data.users.map((u: any) => [u.userId, u]));
    expect(byId.builder1.segment).toBe('builder');
    expect(byId.active1.segment).toBe('active');
    expect(byId.lurker1.segment).toBe('presence');

    // Per-user join is correct.
    expect(byId.builder1.sessions).toBe(12);
    expect(byId.builder1.interactions).toBe(45);
    expect(byId.builder1.websites).toBe(7);
    expect(byId.lurker1.pings).toBe(900);
    expect(byId.lurker1.interactions).toBe(0);
    expect(byId.lurker1.websites).toBe(0);

    // Headline segmentation counts.
    expect(data.summary.totalUsers).toBe(3);
    expect(data.summary.builders).toBe(1);
    expect(data.summary.activeChatRequesters).toBe(1);
    expect(data.summary.openedTabOnly).toBe(1);
    expect(data.segments).toEqual({ builder: 1, active: 1, presence: 1 });

    // Volume rollups keep presence, sessions, interactions, websites separate.
    expect(data.summary.totalPings).toBe(1520);
    expect(data.summary.totalSessions).toBe(46);
    expect(data.summary.totalInteractions).toBe(53);
    expect(data.summary.totalWebsites).toBe(7);

    // Rates.
    expect(data.summary.builderRate).toBe(33); // 1/3
    expect(data.summary.avgWebsitesPerBuilder).toBe(7);
    expect(data.summary.sessionWindowMinutes).toBe(30);
  });

  test('drops synthetic ids but keeps every real sub, including Cognito UUIDs', async () => {
    // A Cognito `sub` IS a UUID, so filtering UUID-shaped ids (as an earlier
    // revision did) erases every user of the public deployment. Only our own
    // synthetic callers are excluded.
    queryScripts.presence = [
      { userId: 'realperson', firstSeen: '1', lastSeen: '2', pings: '10' },
      { userId: 'a8b1d300-1011-7057-79ac-9e31e4773d58', firstSeen: '1', lastSeen: '2', pings: '46' },
      { userId: 'anonymous', firstSeen: '1', lastSeen: '2', pings: '3' },
      { userId: 'canary-probe', firstSeen: '1', lastSeen: '2', pings: '400' },
      { userId: 'edsr-e2e-owner', firstSeen: '1', lastSeen: '2', pings: '2' },
    ];

    const data = await invoke();

    expect(data.users.map((u: any) => u.userId).sort()).toEqual([
      'a8b1d300-1011-7057-79ac-9e31e4773d58',
      'realperson',
    ]);
    expect(data.summary.totalUsers).toBe(2);
  });

  test('a user who only ever pinged (parked tab) counts as presence, not active', async () => {
    queryScripts.presence = [
      { userId: 'tabparker', firstSeen: '1', lastSeen: '2', pings: '1462' },
    ];
    queryScripts.sessions = [{ userId: 'tabparker', sessions: '3' }];
    // No interactions, no websites.

    const data = await invoke();

    expect(data.users[0].segment).toBe('presence');
    expect(data.users[0].pings).toBe(1462);
    expect(data.users[0].sessions).toBe(3);
    expect(data.users[0].interactions).toBe(0);
    expect(data.summary.activeChatRequesters).toBe(0);
    expect(data.summary.builders).toBe(0);
    expect(data.summary.openedTabOnly).toBe(1);
  });

  test('weekly activity exposes sessions and active users, not raw logins', async () => {
    queryScripts.presence = [{ userId: 'u1', firstSeen: '1', lastSeen: '2', pings: '10' }];
    queryScripts.weeklySessions = [
      { week: '2026-09-14', sessions: '20', activeUsers: '5' },
    ];

    const data = await invoke();

    expect(data.weeklyActivity).toEqual([
      { week: '2026-09-14', sessions: 20, activeUsers: 5 },
    ]);
  });

  test('joins users across log groups even when an id carries stray whitespace', async () => {
    // Insights can hand back a parsed field with surrounding whitespace; the
    // join must trim or the user collapses to presence with zero
    // interactions/websites.
    queryScripts.presence = [
      { userId: 'alice\n', firstSeen: '1', lastSeen: '2', pings: '300' },
    ];
    queryScripts.sessions = [{ userId: 'alice\n', sessions: '40' }];
    queryScripts.interactions = [
      { userId: 'alice', chatRequests: '242', enhancerRequests: '0', interactionEvents: '242' },
    ];
    queryScripts.websites = [
      { userId: 'alice', websites: '238', inputTokens: '10', outputTokens: '20', genEvents: '237' },
    ];

    const data = await invoke();

    expect(data.users).toHaveLength(1);
    const u = data.users[0];
    expect(u.userId).toBe('alice'); // normalized, no newline
    expect(u.interactions).toBe(242);
    expect(u.websites).toBe(238);
    expect(u.segment).toBe('builder');
    expect(data.summary.builders).toBe(1);
    expect(data.summary.totalWebsites).toBe(238);
  });

  test('surfaces model usage breakdown and drops default/unknown placeholders', async () => {
    queryScripts.presence = [{ userId: 'u1', firstSeen: '1', lastSeen: '2', pings: '10' }];
    queryScripts.modelUsage = [
      { model: 'global.anthropic.claude-sonnet-4-6', requests: '210', websites: '15', inputTokens: '1000', outputTokens: '2000' },
      { model: 'us.anthropic.claude-sonnet-5', requests: '114', websites: '3', inputTokens: '500', outputTokens: '900' },
      { model: 'default', requests: '16', websites: '0', inputTokens: '0', outputTokens: '0' },
    ];

    const data = await invoke();

    // 'default' placeholder is dropped; real models sorted by requests desc.
    expect(data.modelUsage).toHaveLength(2);
    expect(data.modelUsage[0]).toEqual({
      model: 'global.anthropic.claude-sonnet-4-6',
      requests: 210, websites: 15, inputTokens: 1000, outputTokens: 2000,
    });
    expect(data.modelUsage[1].model).toBe('us.anthropic.claude-sonnet-5');
    expect(data.modelUsage.some((m: any) => m.model === 'default')).toBe(false);
  });
});
