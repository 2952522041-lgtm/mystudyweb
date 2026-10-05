import test from 'node:test';
import { runBrowserFixture, browserAssertions } from './browser-fixture.ts';

void test('course search locates folded content and saved notes; candidate acceptance updates only after explicit action', async () => {
  await runBrowserFixture(`
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {CourseContentSearch} from './components/course-content-search.tsx';
    import {CourseReviewPanel} from './components/course-review-panel.tsx';
    import {CourseNotesPanel} from './components/course-notes-panel.tsx';
    import {KnowledgeSection} from './components/knowledge-section.tsx';
    import {MemoryCourseStorage} from './lib/course-storage/memory-course-storage.ts';
    import {createDocumentDigest} from './lib/knowledge/document-digest.ts';
    const storage=new MemoryCourseStorage();let initial;let lastHit;let update;
    const ai={theme:'新的课程概览',nodes:[{id:'new',label:'新增知识',description:'新的解释',sources:[]}],relations:[],conflicts:[],unresolvedQuestions:[],provider:'fixture',model:'fixture',promptVersion:'fixture'};
    async function boot(){let bundle=await storage.initialize('课程');const digest=createDocumentDigest({fingerprint:'a'.repeat(64),fileName:'讲义.pdf',pages:['折叠目标是搜索必须找到的内容。']});
      bundle=(await storage.importDocument(new File(['pdf'],'讲义.pdf'),digest,{generateSummary:true,generateMindmap:true,mergeIntoCourse:false,includeConversationInsights:false},bundle.manifest.revision)).bundle;
      const note=await storage.loadNotes();await storage.saveNotes('第一行\\n\\n笔记关键词：张量计算',note.token);
      initial=await storage.stageCourseReview([digest.documentId],bundle.manifest.revision,ai);
      function App(){const [current,setCurrent]=useState(initial);const [location,setLocation]=useState(null);update=setCurrent;
        return <><CourseContentSearch bundle={current} storage={storage} onSelect={hit=>{lastHit=hit;setLocation(hit)}}/>
          <KnowledgeSection key={location?.id??'closed'} title="折叠测试" initiallyOpen={location?.kind==='document'||location?.kind==='page'}>折叠目标</KnowledgeSection>
          <CourseNotesPanel storage={storage} courseId={current.manifest.id} focusRequest={location?.kind==='note'?{line:location.line,key:1}:undefined}/>
          <CourseReviewPanel bundle={current} onResolve={async(id,accept)=>setCurrent(await storage.resolveCourseReview(id,accept))}/>
          <output id="live">{current.knowledge.nodes[0].description}</output></>;
      }createRoot(document.getElementById('root')).render(<App/>);
    }void boot();
    ${browserAssertions}
    window.run=async()=>{
      await until('candidate ready',()=>button('接受更新')&&!button('接受更新').disabled);
      check(!document.querySelector('#live').textContent.includes('新的课程概览'),'candidate published early');
      const search=document.querySelector('details');search.open=true;
      await until('notes loaded',()=>document.querySelector('textarea')?.value.includes('张量计算'));
      const input=document.querySelector('input[aria-label="搜索课程内容"]');change(input,'张量计算');
      await until('note result',()=>document.querySelector('[aria-label="课程搜索结果"] button'));
      document.querySelector('[aria-label="课程搜索结果"] button').click();
      await until('note location',()=>document.activeElement===document.querySelector('textarea'));
      check(lastHit.kind==='note'&&lastHit.line===3,'note destination incorrect');
      change(input,'折叠目标');await until('summary result',()=>document.querySelector('[aria-label="课程搜索结果"]').textContent.includes('折叠目标'));
      document.querySelector('[aria-label="课程搜索结果"] button').click();await until('digest destination',()=>lastHit.kind==='document'||lastHit.kind==='page');
      button('接受更新').click();await until('published',()=>document.querySelector('#live').textContent.includes('新的课程概览'));
      check(!(await storage.load()).manifest.pendingReview,'pending review not cleared');
      const live=await storage.load();update(await storage.stageCourseReview([live.manifest.documents[0].id],live.manifest.revision,{...ai,theme:'不会发布的候选'}));
      await until('second review',()=>button('保留原成果'));button('保留原成果').click();
      await until('discarded',()=>!document.querySelector('[aria-label="课程更新审阅"]'));
      check(document.querySelector('#live').textContent.includes('新的课程概览'),'discard changed live knowledge');
    };
  `);
});

void test('backup UI previews the chosen archive and restores only as a new course', async () => {
  await runBrowserFixture(`
    import React from 'react';import {createRoot} from 'react-dom/client';import {CourseBackupActions} from './components/course-backup-actions.tsx';
    const calls=[];window.yeyuDesktop={exportCourseBackup:async id=>{calls.push(['export',id]);return {directory:'/backup/test',name:'test',files:4,bytes:512};},prepareCourseRestore:async()=>({token:'opaque',name:'备份课程',files:4,documents:1,bytes:512,createdAt:'2026-10-05T00:00:00Z'}),restoreCourseBackup:async token=>{calls.push(['restore',token]);return {directoryName:'new-course',courseId:'new',name:'备份课程（恢复）'};}};
    createRoot(document.getElementById('root')).render(<CourseBackupActions directoryName="original" onRestored={async value=>calls.push(['opened',value.courseId])}/>);
    ${browserAssertions}
    window.run=async()=>{await until('buttons',()=>button('备份当前课程'));document.querySelector('details').open=true;
      button('备份当前课程').click();await until('export result',()=>document.body.textContent.includes('/backup/test'));
      button('选择备份恢复').click();await until('preview',()=>button('恢复为新课程'));
      check(!calls.some(v=>v[0]==='restore'),'restored before explicit action');button('取消恢复').click();await until('preview closed',()=>!button('恢复为新课程'));
      button('选择备份恢复').click();await until('preview again',()=>button('恢复为新课程'));button('恢复为新课程').click();await until('restored',()=>calls.some(v=>v[0]==='opened'));
      check(calls.filter(v=>v[0]==='restore').length===1&&calls.find(v=>v[0]==='restore')[1]==='opaque','wrong restore token');
    };
  `);
});
