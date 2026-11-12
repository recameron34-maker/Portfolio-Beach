import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixedClock } from './clock.js';
import { AdapterError, CircuitBreaker, withResilience } from './resilience.js';
import { assertProductionSafe, healthOf, ProductionGuardError } from './registry.js';
import type { AdapterSet } from './registry.js';
import type { Adapter, HealthStatus } from './types.js';
import {
  FixtureLookThroughProvider,
  FixtureMailSource,
  LocalFolderAccountingSystem,
  LocalFolderDocumentStore,
  LocalFolderDrop,
  LocalFolderLookThroughProvider,
  MockAiClient,
  MockIdentityProvider,
  SyntheticBenchmarkProvider,
} from './mocks.js';

const noSleep = (): Promise<void> => Promise.resolve();

describe('withResilience (docs/17 section 5)', () => {
  it('times out a slow call', async () => {
    const slow = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve('late'), 200);
        signal.addEventListener('abort', () => clearTimeout(t));
      });
    await expect(
      withResilience('slow', slow, { timeoutMs: 10, idempotent: false }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('retries idempotent operations with backoff, never non-idempotent ones', async () => {
    let calls = 0;
    const flaky = () => {
      calls++;
      return calls < 3 ? Promise.reject(new Error('transient')) : Promise.resolve('ok');
    };
    const delays: number[] = [];
    const result = await withResilience('flaky', flaky, {
      timeoutMs: 1000,
      idempotent: true,
      retries: 3,
      jitter: () => 0.5,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([150, 300]); // 200 * 2^n * (0.5 + 0.5 * 0.5)
    calls = 0;
    await expect(
      withResilience('flaky', flaky, { timeoutMs: 1000, idempotent: false, sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'exhausted' });
    expect(calls).toBe(1);
  });

  it('opens the circuit after consecutive failures and admits one trial after the reset period', async () => {
    const clock = new FixedClock('2025-01-01T00:00:00Z');
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 60_000, clock });
    const failing = () => Promise.reject(new Error('down'));
    const opts = { timeoutMs: 100, idempotent: false, breaker, sleep: noSleep };
    await expect(withResilience('svc', failing, opts)).rejects.toMatchObject({ code: 'exhausted' });
    await expect(withResilience('svc', failing, opts)).rejects.toMatchObject({ code: 'exhausted' });
    expect(breaker.state).toBe('open');
    await expect(withResilience('svc', failing, opts)).rejects.toMatchObject({
      code: 'circuit_open',
    });
    clock.advance(60_000);
    expect(breaker.state).toBe('half_open');
    await expect(withResilience('svc', () => Promise.resolve('back'), opts)).resolves.toBe('back');
    expect(breaker.state).toBe('closed');
  });

  it('only admits one trial call while half open', () => {
    const clock = new FixedClock('2025-01-01T00:00:00Z');
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetAfterMs: 10, clock });
    breaker.recordFailure();
    clock.advance(10);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
  });

  it('refuses to call an adapter whose kill switch is off', async () => {
    const reader = { isEnabled: (key: string) => Promise.resolve(key !== 'adapter.mail') };
    let called = false;
    await expect(
      withResilience(
        'mail',
        () => {
          called = true;
          return Promise.resolve(1);
        },
        { timeoutMs: 100, idempotent: true, killSwitch: { reader, key: 'adapter.mail' } },
      ),
    ).rejects.toMatchObject({ code: 'kill_switch' });
    expect(called).toBe(false);
    await expect(
      withResilience('docs', () => Promise.resolve(1), {
        timeoutMs: 100,
        idempotent: true,
        killSwitch: { reader, key: 'adapter.documents' },
      }),
    ).resolves.toBe(1);
  });

  it('honors a custom retryability decision', async () => {
    let calls = 0;
    const op = () => {
      calls++;
      return Promise.reject(new Error('fatal'));
    };
    await expect(
      withResilience('x', op, {
        timeoutMs: 100,
        idempotent: true,
        retries: 5,
        sleep: noSleep,
        isRetryable: () => false,
      }),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(calls).toBe(1);
  });
});

function realStub(name: string): Adapter {
  return {
    info: { name, kind: 'real', killSwitch: `adapter.${name}` },
    healthCheck: () => Promise.resolve<HealthStatus>({ ok: true }),
  };
}

function mockSet(): AdapterSet {
  return {
    clock: new FixedClock('2025-06-30T00:00:00Z'),
    identity: new MockIdentityProvider([]),
    documents: new LocalFolderDocumentStore('.'),
    mail: new FixtureMailSource([]),
    accounting: new LocalFolderAccountingSystem('.'),
    weeklyDrop: new LocalFolderDrop('weekly', '.', ['.csv']),
    opsDrop: new LocalFolderDrop('ops_drop', '.', ['.xlsx']),
    lookThrough: new FixtureLookThroughProvider([]),
    ai: new MockAiClient(),
    benchmarks: new SyntheticBenchmarkProvider(),
  };
}

describe('production guard (docs/17 section 6, SEC-17.6)', () => {
  it('refuses to start in production with any mock adapter and names every offender', () => {
    expect(() => assertProductionSafe(mockSet(), { NODE_ENV: 'production' })).toThrow(
      ProductionGuardError,
    );
    try {
      assertProductionSafe(mockSet(), { NODE_ENV: 'production', PB_MOCK_IDENTITY: 'true' });
    } catch (error) {
      expect((error as ProductionGuardError).offenders).toEqual([
        'identity.mock',
        'documents.local_folder',
        'mail.fixtures',
        'accounting.local_folder',
        'drop.local_folder.weekly',
        'drop.local_folder.ops_drop',
        'lookthrough.fixtures',
        'ai.mock',
        'benchmarks.synthetic',
        'mock identity flag',
      ]);
    }
  });

  it('refuses mock identity even when every adapter is real', () => {
    const set = mockSet();
    const real: AdapterSet = {
      ...set,
      identity: realStub('identity') as AdapterSet['identity'],
      documents: realStub('documents') as AdapterSet['documents'],
      mail: realStub('mail') as AdapterSet['mail'],
      accounting: realStub('accounting') as AdapterSet['accounting'],
      weeklyDrop: realStub('weekly_drop') as AdapterSet['weeklyDrop'],
      opsDrop: realStub('ops_drop') as AdapterSet['opsDrop'],
      lookThrough: realStub('lookthrough') as AdapterSet['lookThrough'],
      ai: realStub('ai') as AdapterSet['ai'],
      benchmarks: realStub('benchmarks') as AdapterSet['benchmarks'],
    };
    expect(() => assertProductionSafe(real, { NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertProductionSafe(real, { NODE_ENV: 'production', PB_MOCK_IDENTITY: 'true' }),
    ).toThrow(/mock identity flag/);
  });

  it('allows mocks outside production', () => {
    expect(() => assertProductionSafe(mockSet(), { NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionSafe(mockSet(), {})).not.toThrow();
  });

  it('reports health per adapter', async () => {
    const health = await healthOf(mockSet());
    expect(Object.keys(health)).toHaveLength(9);
    expect(health['ai.mock']?.ok).toBe(true);
    expect(health['drop.local_folder.weekly']?.ok).toBe(true);
    expect(health['drop.local_folder.ops_drop']?.ok).toBe(true);
  });

  it('refuses a drop folder or a folder look-through provider in production, each by name', () => {
    const set: AdapterSet = {
      ...mockSet(),
      lookThrough: new LocalFolderLookThroughProvider('.'),
    };
    try {
      assertProductionSafe(set, { NODE_ENV: 'production' });
      throw new Error('expected the guard to throw');
    } catch (error) {
      expect((error as ProductionGuardError).offenders).toEqual(
        expect.arrayContaining([
          'drop.local_folder.weekly',
          'drop.local_folder.ops_drop',
          'lookthrough.local_folder',
        ]),
      );
    }
  });
});

describe('mock adapters', () => {
  it('identity resolves known external ids and refuses unknown ones', async () => {
    const idp = new MockIdentityProvider([
      {
        id: '10000000-0000-4000-8000-000000000001',
        externalId: 'ops.one',
        displayName: 'Ops One',
        roles: ['operations'],
        clientIds: [],
      },
    ]);
    const p = await idp.authenticate('ops.one');
    expect(p?.roles).toEqual(['operations']);
    expect(await idp.authenticate('nobody')).toBeNull();
    expect(idp.listUsers()).toHaveLength(1);
  });

  it('AI client returns fixtures through the schema, records calls without content, and never invents output', async () => {
    const ai = new MockAiClient({ 'quarterly.extract': { revenue: '12.5', unit: 'USD_M' } });
    const schema = { parse: (v: unknown) => v as { revenue: string; unit: string } };
    const r = await ai.complete(
      { promptId: 'quarterly.extract', promptVersion: '1', input: 'Revenue was 12.5m' },
      schema,
    );
    expect(r.output.unit).toBe('USD_M');
    expect(ai.calls).toEqual([
      { promptId: 'quarterly.extract', promptVersion: '1', inputLength: 17 },
    ]);
    await expect(
      ai.complete({ promptId: 'unknown', promptVersion: '1', input: '' }, schema),
    ).rejects.toThrow(/never invents/);
    ai.register('unknown', { revenue: '1', unit: 'USD' });
    await expect(
      ai.complete({ promptId: 'unknown', promptVersion: '1', input: '' }, schema),
    ).resolves.toBeDefined();
  });

  it('AI client calls a function fixture with the input, parses its answer through the schema, and records no content', async () => {
    const ai = new MockAiClient();
    const seen: string[] = [];
    ai.register('document_classifier', (input: string) => {
      seen.push(input);
      return {
        docType: input.includes('capital call') ? 'doc_type.capital_call' : 'doc_type.other',
      };
    });
    const schema = { parse: (v: unknown) => v as { docType: string } };
    const call = (input: string) =>
      ai.complete({ promptId: 'document_classifier', promptVersion: '1', input }, schema);
    expect((await call('a capital call notice')).output.docType).toBe('doc_type.capital_call');
    expect((await call('a scan')).output.docType).toBe('doc_type.other');
    expect(seen).toEqual(['a capital call notice', 'a scan']);
    expect(ai.calls.map((c) => c.inputLength)).toEqual([21, 6]);
    expect(JSON.stringify(ai.calls)).not.toContain('capital');
  });

  it('AI client rejects with the resolver error or the schema failure and still records the call', async () => {
    const ai = new MockAiClient({
      quarterly_extraction: () => {
        throw new Error('no recorded output for this document');
      },
    });
    const strict = {
      parse: (v: unknown) => {
        if (typeof v !== 'object' || v === null) throw new Error('not an object');
        return v;
      },
    };
    await expect(
      ai.complete({ promptId: 'quarterly_extraction', promptVersion: '1', input: 'x' }, strict),
    ).rejects.toThrow(/no recorded output/);
    ai.register('bad', 'not an object');
    await expect(
      ai.complete({ promptId: 'bad', promptVersion: '1', input: 'yy' }, strict),
    ).rejects.toThrow(/not an object/);
    expect(ai.calls.map((c) => [c.promptId, c.inputLength])).toEqual([
      ['quarterly_extraction', 1],
      ['bad', 2],
    ]);
  });

  it('document store lists, reads, writes and hashes files inside its root only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pb-docs-'));
    const store = new LocalFolderDocumentStore(root);
    expect(await store.list('intake')).toEqual([]);
    const ref = await store.put('intake', 'report.txt', new TextEncoder().encode('hello'));
    expect(ref.contentHash).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    const listed = await store.list('intake');
    expect(listed.map((d) => d.name)).toEqual(['report.txt']);
    expect(new TextDecoder().decode(await store.read(ref.id))).toBe('hello');
    await expect(store.read('../../etc/passwd')).rejects.toThrow(/escapes/);
    expect((await store.healthCheck()).ok).toBe(true);
  });

  it('accounting folders round-trip CSV files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pb-acct-'));
    const acct = new LocalFolderAccountingSystem(root);
    expect(await acct.listExports()).toEqual([]);
    await acct.writeUpload('upload.csv', 'a,b\n1,2\n');
    await expect(acct.readExport('../x.csv')).rejects.toThrow(/invalid/);
    await expect(acct.writeUpload('../x.csv', '')).rejects.toThrow(/invalid/);
  });

  it('mail fixtures filter by mailbox and date; look-through by as-of date', async () => {
    const mail = new FixtureMailSource([
      {
        id: '1',
        receivedAt: '2025-01-02T00:00:00Z',
        from: 'a@sponsor.example',
        to: ['me@portfolio-beach.example'],
        subject: 'Q4',
        body: 'x',
        isInternalOnly: false,
      },
      {
        id: '2',
        receivedAt: '2024-12-02T00:00:00Z',
        from: 'a@sponsor.example',
        to: ['me@portfolio-beach.example'],
        subject: 'Q3',
        body: 'x',
        isInternalOnly: false,
      },
    ]);
    expect(
      (await mail.listMessages('me@portfolio-beach.example', '2025-01-01T00:00:00Z')).map(
        (m) => m.id,
      ),
    ).toEqual(['1']);
    const lt = new FixtureLookThroughProvider([
      {
        investmentNumber: 'INV-0001',
        companyName: 'X',
        sector: 'sector.software',
        geography: 'geography.europe',
        exposureAtCost: '1',
        exposureAtNav: '2',
        asOf: '2025-06-30',
      },
    ]);
    expect(await lt.fetchExposures('2025-06-30')).toHaveLength(1);
    expect(await lt.fetchExposures('2025-03-31')).toHaveLength(0);
  });

  it('benchmark series are deterministic quarter-end levels', async () => {
    const b = new SyntheticBenchmarkProvider();
    const a = await b.indexSeries('PB-SYNTH-PE', '2020-01-01', '2021-12-31');
    const again = await b.indexSeries('PB-SYNTH-PE', '2020-01-01', '2021-12-31');
    expect(a).toEqual(again);
    expect(a.map((p) => p.date)).toEqual([
      '2020-03-31',
      '2020-06-30',
      '2020-09-30',
      '2020-12-31',
      '2021-03-31',
      '2021-06-30',
      '2021-09-30',
      '2021-12-31',
    ]);
    expect(Number(a[7]?.level)).toBeGreaterThan(100);
  });
});

describe('drop folders and the folder look-through provider (docs/04 M2 file drops)', () => {
  it('lists only files of its kind in <root>/in, newest or not, by bare name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pb-drop-'));
    const drop = new LocalFolderDrop('weekly', root, ['.csv']);
    expect(drop.info).toEqual({
      name: 'drop.local_folder.weekly',
      kind: 'mock',
      killSwitch: 'adapter.weekly_drop',
    });
    expect(await drop.listFiles()).toEqual([]);
    await mkdir(join(root, 'in'), { recursive: true });
    await writeFile(join(root, 'in', 'weekly-2025-06-27.csv'), 'a,b\n1,2\n');
    await writeFile(join(root, 'in', 'notes.txt'), 'not a drop');
    await writeFile(join(root, 'in', 'UPPER.CSV'), 'x\n');
    await mkdir(join(root, 'in', 'archive.csv'));
    const listed = await drop.listFiles();
    expect(listed.map((f) => f.id)).toEqual(['UPPER.CSV', 'weekly-2025-06-27.csv']);
    expect(listed[1]?.name).toBe('weekly-2025-06-27.csv');
    expect(listed[1]?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await drop.readText('weekly-2025-06-27.csv')).toBe('a,b\n1,2\n');
    expect(new TextDecoder().decode(await drop.readBytes('weekly-2025-06-27.csv'))).toBe(
      'a,b\n1,2\n',
    );
    expect((await drop.healthCheck()).ok).toBe(true);
  });

  it('reads nothing outside the inbox or of another kind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pb-drop-'));
    await mkdir(join(root, 'in'), { recursive: true });
    await writeFile(join(root, 'in', 'notes.txt'), 'not a drop');
    await writeFile(join(root, 'secret.csv'), 'outside');
    const drop = new LocalFolderDrop('ops_drop', root, ['.xlsx']);
    expect(drop.info.killSwitch).toBe('adapter.ops_drop');
    for (const id of [
      '../secret.csv',
      'in/../secret.csv',
      '/etc/passwd',
      'a\\b.xlsx',
      '',
      'notes.txt',
    ])
      await expect(drop.readText(id), id).rejects.toThrow(/invalid drop id/);
    await expect(drop.readBytes('../secret.csv')).rejects.toThrow(/invalid drop id/);
  });

  it('serves one extract per as-of date and answers no rows when the date has none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pb-lt-'));
    const provider = new LocalFolderLookThroughProvider(root);
    expect(provider.info).toEqual({
      name: 'lookthrough.local_folder',
      kind: 'mock',
      killSwitch: 'adapter.lookthrough',
    });
    expect(await provider.fetchExposures('2025-06-30')).toEqual([]);
    const row = {
      investmentNumber: 'INV-0001',
      companyName: 'Saltmarsh Holdings',
      sector: 'Technology',
      geography: 'North America',
      exposureAtCost: '30000000',
      exposureAtNav: '46000000',
      asOf: '2025-06-30',
    };
    await writeFile(
      join(root, '2025-06-30.json'),
      JSON.stringify([row, { ...row, investmentNumber: null }]),
    );
    expect(await provider.fetchExposures('2025-06-30')).toEqual([
      row,
      { ...row, investmentNumber: null },
    ]);
    expect(await provider.fetchExposures('2025-03-31')).toEqual([]);
    expect((await provider.healthCheck()).ok).toBe(true);
  });

  it('refuses a date that is not a date and an extract that is not exposure rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pb-lt-'));
    const provider = new LocalFolderLookThroughProvider(root);
    for (const asOf of ['../2025-06-30', '2025-06-30.json', 'latest', ''])
      await expect(provider.fetchExposures(asOf), asOf).rejects.toThrow(/invalid as-of date/);
    await writeFile(join(root, '2025-06-30.json'), JSON.stringify({ rows: [] }));
    await expect(provider.fetchExposures('2025-06-30')).rejects.toThrow(
      /not an array of exposure rows/,
    );
    await writeFile(
      join(root, '2025-09-30.json'),
      JSON.stringify([{ companyName: 'X', sector: 'S', geography: 'G', exposureAtCost: 1 }]),
    );
    await expect(provider.fetchExposures('2025-09-30')).rejects.toThrow(
      /not an array of exposure rows/,
    );
  });
});
