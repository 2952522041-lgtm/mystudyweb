import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runBrowserFixture, browserAssertions } from './browser-fixture.ts';

void test('narrow-window course navigation selects existing courses and exposes creation/connection', async () => {
  const require = createRequire(import.meta.url);
  const root = path.resolve(import.meta.dirname, '..');
  const file = path.join(root, 'app/globals.css');
  const css = (
    await require('postcss')([
      require('@tailwindcss/postcss')({ base: root }),
    ]).process(await readFile(file, 'utf8'), { from: file })
  ).css;
  await runBrowserFixture(
    `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {CourseSwitcher} from './components/course-switcher.tsx';
    const root=createRoot(document.getElementById('root'));let selected='a',created=0,connected=0;
    const courses=[{id:'a',name:'第一门课程'},{id:'b',name:'第二门课程很长的名称'.repeat(8)}];
    const render=()=>root.render(<CourseSwitcher courses={courses} activeId={selected} onSelect={id=>{selected=id;render()}} onCreate={()=>created++} onConnect={()=>connected++}/>);render();
    ${browserAssertions}
    window.run=async()=>{
      await until('selector',()=>document.querySelector('select'));
      check(document.querySelector('nav').getBoundingClientRect().width>0,'navigation hidden');
      check(document.documentElement.scrollWidth <= innerWidth,'long course name causes horizontal overflow');
      check(document.querySelector('select').getBoundingClientRect().width >= 100,'selector is unusably narrow');
      change(document.querySelector('select'),'b');await until('selection',()=>selected==='b');
      button('创建课程').click();button('连接课程').click();check(created===1&&connected===1,'actions missing');
      check(document.querySelector('select').value==='b','active option stale');
    };
  `,
    { width: 600, css },
  );
});
