import { test, expect } from '@playwright/test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('deploys the pinned charts with private runtime values and cleans up credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'observatory-deploy-test-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const capture = join(dir, 'calls.json');
    await writeFile(capture, '[]');
    const stub = `#!/usr/bin/env node
const fs=require('fs');const path=require('path');
const name=path.basename(process.argv[1]);const args=process.argv.slice(2);
if(name==='az'){console.log('test-kubeconfig');}
if(name==='kubectl'&&args[0]==='get'){
  if(args[1]==='configmap')console.log(JSON.stringify({data:{'config.json':JSON.stringify({environment:'test',apps:[{namespace:'observatory',url:'https://apps.example.com'}],auth:{apiClientId:'test-api-id'}})}}));
  else console.log(JSON.stringify({items:[{metadata:{name:'observatory-database'},data:{DB_HOST:Buffer.from('postgres.db').toString('base64'),DB_PASSWORD:Buffer.from('a quoted secret with spaces').toString('base64')}},{metadata:{name:'observatory-github'},data:{token:Buffer.from('test-github-token').toString('base64')}}]}));
}
if(name==='helm'&&args[0]==='upgrade'){
  const file=args[args.lastIndexOf('-f')+1];
  const calls=JSON.parse(fs.readFileSync(process.env.DEPLOY_TEST_CAPTURE,'utf8'));
  calls.push({args,file,mode:fs.statSync(file).mode&511,values:JSON.parse(fs.readFileSync(file,'utf8'))});
  fs.writeFileSync(process.env.DEPLOY_TEST_CAPTURE,JSON.stringify(calls));
}
`;
    for (const name of ['az', 'kubectl', 'helm'])
      await writeFile(join(bin, name), stub, { mode: 0o755 });
    const image = `ghcr.io/example/observatory:sha-${'a'.repeat(40)}`;
    const { stdout } = await promisify(execFile)(
      'bash',
      ['scripts/deploy.sh'],
      {
        cwd: resolve(__dirname, '../..'),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEPLOY_TEST_CAPTURE: capture,
          AZURE_KEYVAULT_NAME: 'test',
          SERVER_IMAGE: image,
          CLIENT_IMAGE: image,
        },
      }
    );
    const calls = JSON.parse(await readFile(capture, 'utf8'));
    expect(calls).toHaveLength(2);
    expect(calls[0].args.slice(0, 3)).toEqual([
      'upgrade',
      'observatory',
      'mucsi96/go-app',
    ]);
    expect(calls[0].args[calls[0].args.indexOf('--version') + 1]).toBe('1.0.0');
    expect(calls[1].args.slice(0, 3)).toEqual([
      'upgrade',
      'observatory-client',
      'mucsi96/client-app',
    ]);
    expect(calls[1].args[calls[1].args.indexOf('--version') + 1]).toBe(
      '22.0.0'
    );
    expect(calls[0].values.env.DB_PASSWORD).toBe('a quoted secret with spaces');
    expect(calls[0].values.env.GITHUB_TOKEN).toBe('test-github-token');
    expect(calls[0].values.env.CONFIG_FILE).toBe('/config/config.json');
    expect(
      JSON.parse(
        Buffer.from(calls[0].values.configFile[0].data, 'base64').toString()
      ).auth.apiClientId
    ).toBe('test-api-id');
    for (const call of calls) {
      expect(call.args).toContain('--take-ownership');
      expect(call.values.host).toBe('apps.example.com');
      expect(call.mode & 0o077).toBe(0);
      await expect(access(call.file)).rejects.toThrow();
    }
    expect(stdout).not.toContain('test-github-token');
    expect(stdout).not.toContain('a quoted secret with spaces');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
