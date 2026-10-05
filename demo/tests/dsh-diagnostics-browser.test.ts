import { test } from 'node:test';

import { browserAssertions, runBrowserFixture } from './browser-fixture.ts';

await test('DshDiagnosticsPanel browser behavior', async () => {
  const entry = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DshDiagnosticsPanel } from '@/components/dsh-diagnostics-panel.tsx';

${browserAssertions}

const container = document.getElementById('root');

const makeRecord = (index, overrides) => Object.assign({
  id: 'rec-' + index,
  model: 'dsh-model-' + index,
  task: 'background',
  status: 'completed',
  startedAt: '2024-01-02T03:04:05.000Z',
  queueMs: 1000,
  startupMs: 2000,
  executionMs: 3000,
  totalMs: 7000,
  retries: 1
}, overrides);

async function mount(loader, run) {
  const host = document.createElement('div');
  container.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(DshDiagnosticsPanel, { loadRecords: loader }));
  await until('panel summary', () => host.querySelector('summary'));
  await run(host);
  root.unmount();
  host.remove();
}

window.run = async () => {
  // Lazy first-open load, rendered fields, mapped errors, refresh, error preserves records.
  {
    const records = [makeRecord(1, {
      model: 'alpha-model',
      reused: true,
      errorCode: 'network',
      prompt: 'SECRET_PROMPT',
      apiKey: 'SECRET_KEY',
      response: 'SECRET_RESPONSE',
      endpoint: 'https://secret.example',
      rawError: 'SECRET_RAW'
    })];
    let calls = 0;
    let fail = false;
    const loader = async () => {
      calls += 1;
      await sleep(5);
      if (fail) throw new Error('RAW_SECRET_ERROR');
      return records.map(record => Object.assign({}, record));
    };
    await mount(loader, async host => {
      check(calls === 0, 'must not load before first open');
      const summary = host.querySelector('summary');
      check(summary.textContent.trim() === 'DSH 运行记录', 'summary text');
      summary.click();
      await until('record visible', () => host.querySelector('[data-dsh-record]'));
      check(calls === 1, 'first open loads once, got ' + calls);
      check(host.textContent.includes('alpha-model'), 'model shown');
      check(host.textContent.includes('复用并发结果'), 'reused marker shown');
      check(host.textContent.includes('DSH 网络连接失败'), 'mapped error shown');
      check(!document.body.textContent.includes('SECRET'), 'sensitive fields never rendered');

      const refresh = button('刷新');
      check(refresh, 'refresh button exists');
      refresh.click();
      await until('refreshed', () => calls >= 2);
      check(host.querySelector('[data-dsh-record]'), 'record after refresh');

      fail = true;
      refresh.click();
      await until('load error shown', () => host.querySelector('[role=alert]'));
      check(host.querySelector('[data-dsh-record]'), 'records preserved on refresh error');
    });
  }

  // Programmatic open also triggers the lazy load.
  {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return [makeRecord(0, { model: 'programmatic-model' })];
    };
    await mount(loader, async host => {
      host.querySelector('details').open = true;
      await until('programmatic load', () => host.textContent.includes('programmatic-model'));
      check(calls === 1, 'programmatic open loads once, got ' + calls);
    });
  }

  // Empty state.
  {
    const loader = async () => [];
    await mount(loader, async host => {
      host.querySelector('summary').click();
      await until('empty text', () => host.textContent.includes('暂无运行记录'));
      check(
        host.textContent.includes('仅保留最近 200 条完成或失败的调用记录；未提供 token 用量时不估算费用。'),
        'records note'
      );
    });
  }

  // Pagination and filter reset.
  {
    const records = [];
    for (let index = 0; index < 45; index += 1) {
      const status = index % 3 === 0 ? 'failed' : index % 3 === 1 ? 'cancelled' : 'completed';
      records.push(makeRecord(index, { status }));
    }
    const loader = async () => records.map(record => Object.assign({}, record));
    await mount(loader, async host => {
      host.querySelector('summary').click();
      await until('first page', () => host.querySelectorAll('[data-dsh-record]').length === 20);
      const more = button('显示更多记录');
      check(more, 'more button shown');
      more.click();
      await until('second page', () => host.querySelectorAll('[data-dsh-record]').length === 40);

      const select = host.querySelector('select');
      change(select, 'failed');
      await until('failed only', () => {
        const items = [...host.querySelectorAll('[data-dsh-record]')];
        return items.length > 0 && items.every(item => item.textContent.includes('失败'));
      });
      check(host.querySelectorAll('[data-dsh-record]').length <= 20, 'filter caps page size');

      change(select, 'all');
      await until('page reset after filter', () => host.querySelectorAll('[data-dsh-record]').length === 20);
    });
  }

  // No matching filter versus no records.
  {
    const records = [makeRecord(0), makeRecord(1)];
    const loader = async () => records.map(record => Object.assign({}, record));
    await mount(loader, async host => {
      host.querySelector('summary').click();
      await until('completed records', () => host.querySelectorAll('[data-dsh-record]').length === 2);
      change(host.querySelector('select'), 'failed');
      await until('no match', () => host.textContent.includes('没有符合当前筛选条件的记录'));
    });
  }

  // Stale responses never overwrite a newer refresh result.
  {
    const resolvers = [];
    const loader = () => new Promise(resolve => { resolvers.push(resolve); });
    await mount(loader, async host => {
      host.querySelector('summary').click();
      await until('first request', () => resolvers.length === 1);
      button('刷新').click();
      await until('second request', () => resolvers.length === 2);
      resolvers[1]([makeRecord(2, { model: 'newer-model' })]);
      await until('newer shown', () => host.textContent.includes('newer-model'));
      resolvers[0]([makeRecord(1, { model: 'older-model' })]);
      await sleep(30);
      check(host.textContent.includes('newer-model'), 'newer refresh result kept');
      check(!host.textContent.includes('older-model'), 'stale response discarded');
    });
  }
};
`;

  await runBrowserFixture(entry);
});
