import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

/** Real isolated Chromium; fixture assertions throw inside window.run(). */
export async function runBrowserFixture(
  entry: string,
  options: { width?: number; height?: number; css?: string } = {},
) {
  const root = path.resolve(import.meta.dirname, '..');
  const require = createRequire(import.meta.url);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yeyu-browser-check-'));
  let server: http.Server | undefined;
  try {
    const bundle = await build({
      stdin: { contents: entry, loader: 'tsx', resolveDir: root },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      tsconfig: path.join(root, 'tsconfig.json'),
    });
    server = http.createServer((req, res) => {
      if (req.url === '/fixture.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(bundle.outputFiles[0].contents);
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          `<html><head><style>${options.css ?? ''}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        );
      }
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as { port: number };
    const main = path.join(dir, 'main.cjs');
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:true,width:${options.width ?? 820},height:${options.height ?? 700},webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      try{await win.loadURL('http://127.0.0.1:${address.port}');await win.webContents.executeJavaScript('window.run()',true);console.log('FIXTURE_OK');win.destroy();app.exit(0);}catch(e){console.error(e);win.destroy();app.exit(1);}
    });`,
    );
    const electron = require('electron') as string;
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY;
    const args = [
      '--no-sandbox',
      '--disable-gpu',
      '--ozone-platform=x11',
      `--user-data-dir=${dir}/profile`,
      main,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        xvfb ? 'xvfb-run' : electron,
        xvfb ? ['-a', electron, ...args] : args,
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (value) => {
        output += value;
      });
      child.stderr.on('data', (value) => {
        output += value;
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Browser timeout: ${output}`));
      }, 45000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && output.includes('FIXTURE_OK')) resolve();
        else reject(new Error(output));
      });
    });
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

export const browserAssertions = `
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message)};
const button=text=>[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
async function until(message,predicate){for(let i=0;i<300;i++){if(predicate())return;await sleep(10)}throw new Error(message+' '+document.body.textContent.slice(-1800))}
const change=(node,value)=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value').set.call(node,value);node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));};
`;
